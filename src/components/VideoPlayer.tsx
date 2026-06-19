import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Loader2, AlertCircle, Settings2, Check } from "lucide-react";

interface Props {
  bvid: string;
  cid: number;
  epId?: number;
  duration: number;
  title: string;
  onBack: () => void;
}

interface PlayQuality {
  qn: number;
  label: string;
  codec: string;
  video_url: string;
}

interface PlayStreams {
  qualities: PlayQuality[];
  audio_url: string;
  has_audio: boolean;
  default_qn: number;
  duration: number;
}

/** 记住本会话上次手动选择的画质，下次打开沿用（播放器单实例） */
let lastChosenQn: number | null = null;

/** B站流 URL → biliproxy 代理 URL（base64url 编码进路径，绕跨域 + 补 Referer）。
 *  Windows WebView2 下自定义协议地址形如 http://biliproxy.localhost/<path> */
function proxyUrl(biliUrl: string): string {
  const b64 = btoa(biliUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `http://biliproxy.localhost/b/${b64}`;
}

/** 等待 SourceBuffer 完成上一次 append/remove（期间不能再操作同一个 buffer） */
function waitUpdate(sb: SourceBuffer): Promise<void> {
  return new Promise((res) => sb.addEventListener("updateend", () => res(), { once: true }));
}

/** 探测 AVC 最高可用 level 作为 SourceBuffer codec 串（Chromium 实际按 SPS 解码，level 偏高无害，
 *  但声明的 level 太低可能在某些 webview 拒绝高分辨率流，故取最高支持者） */
function bestAvcCodec(): string {
  const candidates = [
    'video/mp4; codecs="avc1.640034"', // High profile L5.2（覆盖 4K）
    'video/mp4; codecs="avc1.4D4028"', // Main profile L4.0（1080P）
    'video/mp4; codecs="avc1.42E01E"', // Baseline L3.0（兜底）
  ];
  for (const c of candidates) {
    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(c)) return c;
  }
  return 'video/mp4; codecs="avc1.42E01E"';
}

const AHEAD_S = 20; // 本条流在 currentTime 之前最多缓冲 20 秒，够了就暂停拉取，随播放推进再续
const BEHIND_S = 5; // 保留 currentTime 之后 5 秒，更早的回收，释放 SourceBuffer 空间
const KEEP_S = AHEAD_S + BEHIND_S + 5; // 追帧期保留的尾部窗口（画质切换续播时防止 [0,resumeTime] 全堆内存撑爆）
const BLIND_CAP = 4 * 1024 * 1024; // 缓冲范围解析出来前最多盲目取 4MB（init 段还在路上时封顶，防止狂拉）

/** 本 SourceBuffer 在 t 之后的已缓冲秒数。
 *  关键：必须用 sb.buffered（本条流自己的范围），不能用 video.buffered ——
 *  video.buffered 是「视频/音频两路 SourceBuffer 的交集」，一路慢了会让另一路误判「前方不足」无限狂拉 → 撑爆配额。 */
function ownAhead(sb: SourceBuffer, t: number): number {
  for (let i = 0; i < sb.buffered.length; i++) {
    if (sb.buffered.start(i) <= t && t <= sb.buffered.end(i)) {
      return sb.buffered.end(i) - t;
    }
  }
  return 0;
}

/** 本 SourceBuffer 的缓冲末端（秒），无缓冲返回 0 */
function bufferedEnd(sb: SourceBuffer): number {
  return sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0;
}

/** 等缓冲范围解析出来（init 段到位） */
function waitForParsed(sb: SourceBuffer, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted || sb.buffered.length > 0) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** 节奏跟随：本条流前方缓冲不足 AHEAD_S 才放行取下一块（被取消时 resolve） */
function waitForOwnNeed(sb: SourceBuffer, video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve();
      if (sb.buffered.length === 0) return resolve(); // 缓冲范围还没解析出来 → 放行（靠 BLIND_CAP 在调用侧封顶）
      if (ownAhead(sb, video.currentTime) < AHEAD_S) return resolve();
      setTimeout(tick, 400);
    };
    tick();
  });
}

/** 回收已播放段：删掉 [0, currentTime - BEHIND_S]，给新数据腾位 */
async function evictBehind(sb: SourceBuffer, video: HTMLVideoElement): Promise<void> {
  const removeEnd = video.currentTime - BEHIND_S;
  if (removeEnd <= 0.5) return;
  try {
    if (sb.updating) await waitUpdate(sb);
    if (sb.buffered.length > 0 && sb.buffered.start(0) < removeEnd) {
      sb.remove(0, removeEnd);
      await waitUpdate(sb);
    }
  } catch {
    /* 偶发 remove 失败忽略 */
  }
}

/** 追帧期回收：只保留尾部 KEEP_S 窗口，删掉更早的前段（不依赖 currentTime，因追帧期 currentTime≈0） */
async function evictFront(sb: SourceBuffer): Promise<void> {
  if (sb.buffered.length === 0) return;
  const evictEnd = bufferedEnd(sb) - KEEP_S;
  if (evictEnd <= sb.buffered.start(0)) return;
  try {
    if (sb.updating) await waitUpdate(sb);
    sb.remove(0, evictEnd);
    await waitUpdate(sb);
  } catch {
    /* 忽略 */
  }
}

/** appendBuffer：配额不足（QuotaExceeded / SourceBuffer is full）时先强制回收再重试一次 */
async function appendSafe(sb: SourceBuffer, buf: ArrayBuffer, video: HTMLVideoElement): Promise<void> {
  try {
    sb.appendBuffer(buf);
  } catch {
    await evictBehind(sb, video);
    if (video.currentTime > 0.5) {
      try {
        if (sb.updating) await waitUpdate(sb);
        sb.remove(0, video.currentTime);
        await waitUpdate(sb);
      } catch {
        /* 忽略 */
      }
    }
    sb.appendBuffer(buf); // 重试一次；再失败就让异常抛出
  }
  await waitUpdate(sb);
}

/**
 * 边下边播。catchUpTo>0 时进入「追帧」模式（画质切换续播）：缓冲末端到达 catchUpTo 前不按播放节奏节流，
 * 尽快拉满，并用尾部窗口回收（evictFront）防止 [0,resumeTime] 全堆内存撑爆；到达后切回正常节奏 + evictBehind。
 */
async function feedStream(
  url: string,
  sb: SourceBuffer,
  video: HTMLVideoElement,
  signal: AbortSignal,
  catchUpTo = 0,
): Promise<void> {
  let start = 0;
  let total = Infinity;
  const CHUNK = 2 * 1024 * 1024; // 2MB / 块
  while (start < total) {
    if (signal.aborted) return;
    const catchingUp = catchUpTo > 0 && bufferedEnd(sb) < catchUpTo;
    if (!catchingUp) {
      // 正常节奏：缓冲范围未解析出且盲取够 → 等解析；否则等前方不足
      if (sb.buffered.length === 0 && start >= BLIND_CAP) {
        await waitForParsed(sb, signal);
        if (signal.aborted) return;
      } else {
        await waitForOwnNeed(sb, video, signal);
        if (signal.aborted) return;
      }
    }
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + CHUNK - 1}` }, signal });
    if (res.status !== 206 && res.status !== 200) throw new Error(`拉流失败 HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return;
    const cr = res.headers.get("content-range");
    total = cr ? parseInt(cr.split("/")[1], 10) : start + buf.byteLength;
    if (catchingUp) await evictFront(sb); // 追帧期：维持尾部窗口
    else await evictBehind(sb, video); // 正常：回收已播放段
    await appendSafe(sb, buf, video);
    start += buf.byteLength;
  }
}

/** 等缓冲覆盖 target 时刻（画质切换续播：追帧到位即可 seek） */
function waitForBuffered(video: HTMLVideoElement, target: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve();
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= target && target <= video.buffered.end(i) - 0.1) return resolve();
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

export function VideoPlayer({ bvid, cid, epId, duration, title, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [qualities, setQualities] = useState<PlayQuality[]>([]);
  const [selectedQn, setSelectedQn] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // MSE 生命周期（初始打开 / 画质切换 / 卸载清理 共用）
  const acRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const qualitiesRef = useRef<PlayQuality[]>([]);
  const audioRef = useRef<{ url: string; has: boolean }>({ url: "", has: false });

  const reportError = useCallback((msg: string) => {
    if (cancelledRef.current) return; // 已卸载 / StrictMode 重跑，不再报错
    invoke("log_player_error", { msg }).catch(() => {});
    setError(msg);
  }, []);

  /** 打开/切换到指定画质。resumeTime>0.5 表示画质切换续播（快速追帧到该时刻再 seek+play） */
  const play = useCallback(async (quality: PlayQuality, resumeTime: number) => {
    // 清理上一路（中止旧拉流、回收旧 objectUrl）
    if (acRef.current) acRef.current.abort();
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (cancelledRef.current) return;

    setLoading(true);
    setError(null);
    const video = videoRef.current;
    if (!video) return;

    const videoMime = bestAvcCodec();
    const audioMime = 'audio/mp4; codecs="mp4a.40.2"';
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(videoMime)) {
      reportError("当前 WebView 不支持 MSE 播放");
      return;
    }

    const ac = new AbortController();
    acRef.current = ac;
    const mediaSource = new MediaSource();
    objectUrlRef.current = URL.createObjectURL(mediaSource);

    const switching = resumeTime > 0.5;
    video.autoplay = !switching;
    video.src = objectUrlRef.current;
    if (switching) {
      try { video.pause(); } catch { /* 防止 autoPlay 从 0 开始播 */ }
    }

    const hideLoading = () => { if (!cancelledRef.current) setLoading(false); };

    mediaSource.addEventListener("sourceopen", async () => {
      try {
        const vsb = mediaSource.addSourceBuffer(videoMime);
        const ai = audioRef.current;
        const asb = ai.has && ai.url && MediaSource.isTypeSupported(audioMime)
          ? mediaSource.addSourceBuffer(audioMime)
          : null;
        // 视频、音频并行拉取 append；MSE 负责时间轴同步
        const tasks: Promise<void>[] = [feedStream(proxyUrl(quality.video_url), vsb, video, ac.signal, resumeTime)];
        if (asb) tasks.push(feedStream(proxyUrl(ai.url), asb, video, ac.signal, resumeTime));
        const feed = Promise.all(tasks);

        if (switching) {
          // 追帧到 resumeTime → seek + 续播
          await waitForBuffered(video, resumeTime, ac.signal);
          if (cancelledRef.current || ac.signal.aborted) return;
          try { video.currentTime = resumeTime; await video.play(); } catch { /* 忽略 */ }
          hideLoading();
        } else {
          // 首次打开：有足够数据可播即隐藏 loading
          video.addEventListener("canplay", hideLoading, { signal: ac.signal });
          video.addEventListener("playing", hideLoading, { signal: ac.signal });
        }
        await feed;
        if (!cancelledRef.current && !ac.signal.aborted && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          ac.abort(); // 出错就停掉另一条流，避免继续狂拉
          reportError(`播放流加载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        // 仅当本次 ac 仍是当前流时才收尾（避免旧流的 finally 覆盖新流的 loading 状态）
        if (!cancelledRef.current && acRef.current === ac) setLoading(false);
      }
    }, { once: true });
  }, [reportError]);

  // 初次加载：取画质列表 → 选默认画质 → 打开
  useEffect(() => {
    // 本地 active 旗标：StrictMode 重跑时让上一轮 await 回来后 bail（cancelledRef 会被下一轮重置成 false，拦不住）
    let active = true;
    cancelledRef.current = false;
    (async () => {
      try {
        const streams = await invoke<PlayStreams>("get_play_streams", {
          bvid, cid, epId: epId ?? null, duration,
        });
        if (!active) return;
        if (!streams.qualities.length) throw new Error("未取到视频流地址（可能需要登录或遇到风控）");
        qualitiesRef.current = streams.qualities;
        audioRef.current = { url: streams.audio_url, has: streams.has_audio };
        setQualities(streams.qualities);
        // 沿用本会话上次选择（若该画质可用），否则取默认（最高）
        const qn = lastChosenQn != null && streams.qualities.some(q => q.qn === lastChosenQn)
          ? lastChosenQn
          : streams.default_qn;
        setSelectedQn(qn);
        const q = streams.qualities.find(x => x.qn === qn) ?? streams.qualities[0];
        await play(q, 0);
      } catch (e) {
        if (!active) return;
        reportError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
      if (acRef.current) acRef.current.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [bvid, cid, epId, duration, play, reportError]);

  /** 画质切换：记住选择，从当前位置续播 */
  const switchQuality = useCallback((qn: number) => {
    const q = qualitiesRef.current.find(x => x.qn === qn);
    if (!q) return;
    const resumeTime = videoRef.current?.currentTime ?? 0;
    lastChosenQn = qn;
    setSelectedQn(qn);
    setMenuOpen(false);
    void play(q, resumeTime);
  }, [play]);

  const currentLabel = qualities.find(q => q.qn === selectedQn)?.label ?? "画质";

  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col">
      {/* 顶部：返回 + 标题 + 画质 */}
      <div className="relative z-30 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={onBack} className="p-2 rounded-lg text-white hover:bg-white/10 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-sm font-medium text-white truncate flex-1">{title}</h1>

        {/* 画质选择 */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(v => !v)}
            disabled={qualities.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40"
          >
            <Settings2 size={15} />
            <span>{currentLabel}</span>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 min-w-[150px] rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl py-1 max-h-[60vh] overflow-auto">
                {qualities.map(q => (
                  <button
                    key={q.qn}
                    onClick={() => switchQuality(q.qn)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                  >
                    <span>{q.label}</span>
                    {q.qn === selectedQn && <Check size={14} className="text-emerald-400" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 视频区。min-h-0 关键：flex 子项默认 min-height:auto 不允许收缩，
          竖屏视频原生很高会把本区撑到视口外，导致下半部分被裁掉看不到。 */}
      <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden">
        <video ref={videoRef} controls autoPlay className="max-w-full max-h-full object-contain" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/80 pointer-events-none">
            <Loader2 size={24} className="animate-spin" />
            <span className="text-sm">加载播放流中...</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/90 px-6 text-center">
            <AlertCircle size={28} />
            <p className="text-sm">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
