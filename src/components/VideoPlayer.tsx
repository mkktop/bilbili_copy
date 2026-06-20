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

// ---- 精准拖动索引（后端 get_seek_index 返回）----
interface SeekPoint { time_secs: number; byte: number; }
interface StreamSeekIndex { init_end: number; points: SeekPoint[]; }
interface SeekIndexResult { video: StreamSeekIndex | null; audio: StreamSeekIndex | null; }
// 精准 seek 计划：目标分片 moof 字节偏移 + init 段边界（重建 SourceBuffer 后先 append init 再从 moof 拉）。
// 分片式 fMP4 的 moof 自带绝对时间(tfdt)，MSE 按真实时间放置，无需 timestampOffset。
interface SeekPlan {
  videoByte: number; initEndVideo: number;
  audioByte: number; initEndAudio: number;
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

/** 时刻 t 是否落在 video 已缓冲范围内（含小余量） */
function isBuffered(video: HTMLVideoElement, t: number): boolean {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) - 0.1 <= t && t <= video.buffered.end(i) - 0.1) return true;
  }
  return false;
}

/** 索引里找 time ≤ t 的最大点（点按时间升序） */
function lookupPoint(points: SeekPoint[], t: number): SeekPoint | null {
  let lo = 0, hi = points.length - 1, ans: SeekPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time_secs <= t) { ans = points[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

const AHEAD_S = 20; // 本条流在 currentTime 之前最多缓冲 20 秒，够了就暂停拉取，随播放推进再续
const BEHIND_S = 5; // 保留 currentTime 之后 5 秒，更早的回收，释放 SourceBuffer 空间
const KEEP_S = AHEAD_S + BEHIND_S + 5; // 追帧期保留的尾部窗口（画质切换/精准 seek 续播时防止全堆内存撑爆）
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
 * 边下边播。startByte>0 用于精准 seek（从关键帧字节开始拉，init 段已由调用方 append）。
 * catchUpTo>0 时进入「追帧」模式：缓冲末端到达 catchUpTo 前不按播放节奏节流，尽快拉满，
 * 并用尾部窗口回收（evictFront）防止全堆内存撑爆；到达后切回正常节奏 + evictBehind。
 */
async function feedStream(
  url: string,
  sb: SourceBuffer,
  video: HTMLVideoElement,
  signal: AbortSignal,
  catchUpTo = 0,
  startByte = 0,
): Promise<void> {
  let start = startByte;
  let total = Infinity;
  const CHUNK = 2 * 1024 * 1024; // 2MB / 块
  try {
    while (start < total) {
      if (signal.aborted) return;
      const catchingUp = catchUpTo > 0 && bufferedEnd(sb) < catchUpTo;
      if (!catchingUp) {
        // 正常节奏：缓冲范围未解析出且本轮盲取够 → 等解析；否则等前方不足
        if (sb.buffered.length === 0 && (start - startByte) >= BLIND_CAP) {
          await waitForParsed(sb, signal);
          if (signal.aborted) return;
        } else {
          await waitForOwnNeed(sb, video, signal);
          if (signal.aborted) return;
        }
      }
      const { buf, total: t } = await fetchRangeTotal(url, start, start + CHUNK, signal);
      if (buf.byteLength === 0) return;
      total = t;
      if (catchingUp) await evictFront(sb); // 追帧期：维持尾部窗口
      else await evictBehind(sb, video); // 正常：回收已播放段
      await appendSafe(sb, buf, video);
      start += buf.byteLength;
    }
  } catch (e) {
    if (signal.aborted) return; // 取消不算错（seek / 切画质 abort 旧拉取）
    throw e;
  }
}

/** fetchRange 同时返回 total（来自 content-range） */
async function fetchRangeTotal(url: string, start: number, endExclusive: number, signal?: AbortSignal): Promise<{ buf: ArrayBuffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endExclusive - 1}` }, signal });
  if (res.status !== 206 && res.status !== 200) throw new Error(`拉流失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const cr = res.headers.get("content-range");
  const total = cr ? parseInt(cr.split("/")[1], 10) : start + buf.byteLength;
  return { buf, total };
}

/** 等缓冲覆盖 target 时刻（画质切换/精准 seek 续播：追帧到位即可 seek） */
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
  const freezeCanvasRef = useRef<HTMLCanvasElement | null>(null); // 精准 seek 重建期的冻结帧 overlay（canvas 同步绘制，盖住黑屏）

  // MSE 生命周期（初始打开 / 画质切换 / 精准 seek / 卸载清理 共用）
  const acRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const qualitiesRef = useRef<PlayQuality[]>([]);
  const audioRef = useRef<{ url: string; has: boolean }>({ url: "", has: false });
  const currentQualityRef = useRef<PlayQuality | null>(null);
  // 精准拖动索引（仅当 video 可用、且与当前画质 URL 匹配时启用）
  const seekIndexRef = useRef<{ videoUrl: string; video?: StreamSeekIndex; audio?: StreamSeekIndex } | null>(null);
  const inSeekRef = useRef(false); // 防止 seek 重入

  const reportError = useCallback((msg: string) => {
    if (cancelledRef.current) return; // 已卸载 / StrictMode 重跑，不再报错
    invoke("log_player_error", { msg }).catch(() => {});
    setError(msg);
  }, []);

  /** 异步加载精准拖动索引（非阻塞，失败静默） */
  const loadSeekIndex = useCallback(async (videoUrl: string, audioUrl: string) => {
    seekIndexRef.current = null;
    try {
      const r = await invoke<SeekIndexResult>("get_seek_index", { videoUrl, audioUrl });
      if (cancelledRef.current) return;
      seekIndexRef.current = { videoUrl, video: r.video ?? undefined, audio: r.audio ?? undefined };
    } catch {
      /* 精准 seek 可选，失败静默 → seekTo 会走回退 */
    }
  }, []);

  /**
   * 打开/切换/精准 seek 到指定画质。
   * - resumeTime=0：首次打开（从 0 顺序播）。
   * - resumeTime=0：首次打开（从 0 顺序播）。
   * - resumeTime>0.5 无 seek：画质切换续播（重建流，从 0 追帧到 resumeTime）。
   * - 带 seek：精准 seek（重建流 + append init，从目标分片 moof 字节拉，追帧到 resumeTime）。
   *   重建会清帧，调用方应先用冻结帧 overlay 盖住避免黑屏。
   */
  const play = useCallback(async (quality: PlayQuality, resumeTime: number, seek?: SeekPlan) => {
    // 清理上一路（中止旧拉流、回收旧 objectUrl）
    if (acRef.current) acRef.current.abort();
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (cancelledRef.current) return;

    currentQualityRef.current = quality;
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

    // 异步预取精准拖动索引（不阻塞起播）
    void loadSeekIndex(quality.video_url, audioRef.current.url);

    const ac = new AbortController();
    acRef.current = ac;
    const mediaSource = new MediaSource();
    objectUrlRef.current = URL.createObjectURL(mediaSource);

    const switching = resumeTime > 0.5; // 画质切换 或 精准 seek 都走「追帧 + 续播」
    video.autoplay = !switching;
    video.src = objectUrlRef.current;
    if (switching) {
      try { video.pause(); } catch { /* 防止 autoPlay 从 0 开始播 */ }
    }

    const hideLoading = () => {
      if (!cancelledRef.current) {
        setLoading(false);
        if (freezeCanvasRef.current) freezeCanvasRef.current.style.display = "none";
      }
    };

    mediaSource.addEventListener("sourceopen", async () => {
      try {
        const vsb = mediaSource.addSourceBuffer(videoMime);
        const ai = audioRef.current;
        const asb = ai.has && ai.url && MediaSource.isTypeSupported(audioMime)
          ? mediaSource.addSourceBuffer(audioMime)
          : null;

        // 精准 seek：先 append init 段（ftyp+moov+sidx → 解析器拿到 moov init），再从目标分片 moof 字节拉
        if (seek) {
          const vInit = await fetchRangeTotal(proxyUrl(quality.video_url), 0, seek.initEndVideo, ac.signal);
          await appendSafe(vsb, vInit.buf, video);
          if (asb && seek.initEndAudio > 0) {
            const aInit = await fetchRangeTotal(proxyUrl(ai.url), 0, seek.initEndAudio, ac.signal);
            await appendSafe(asb, aInit.buf, video);
          }
        }

        // 视频、音频并行拉取 append；MSE 负责时间轴同步
        const tasks: Promise<void>[] = [feedStream(proxyUrl(quality.video_url), vsb, video, ac.signal, resumeTime, seek?.videoByte ?? 0)];
        if (asb) tasks.push(feedStream(proxyUrl(ai.url), asb, video, ac.signal, resumeTime, seek?.audioByte ?? 0));
        const feed = Promise.all(tasks);

        if (switching) {
          await waitForBuffered(video, resumeTime, ac.signal);
          if (cancelledRef.current || ac.signal.aborted) return;
          try { video.currentTime = resumeTime; await video.play(); } catch { /* 忽略 */ }
          hideLoading();
        } else {
          video.addEventListener("canplay", hideLoading, { signal: ac.signal });
          video.addEventListener("playing", hideLoading, { signal: ac.signal });
        }
        await feed;
        if (!cancelledRef.current && !ac.signal.aborted && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          ac.abort();
          reportError(`播放流加载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        if (!cancelledRef.current && acRef.current === ac) setLoading(false);
      }
    }, { once: true });
  }, [reportError, loadSeekIndex]);

  // 初次加载：取画质列表 → 选默认画质 → 打开
  useEffect(() => {
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

  /** 精准拖动：拖到未缓冲处时，捕获当前帧做冻结 overlay（盖住重建黑屏），重建流并从目标分片 moof 字节拉。
   *  必须重建（abort 旧拉取会留下半截 fragment，直接复用 SourceBuffer 会让解析器混乱报致命错）。*/
  const seekTo = useCallback((t: number) => {
    if (inSeekRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    if (isBuffered(video, t)) return; // 已缓冲 → 原生瞬时 seek
    const idx = seekIndexRef.current;
    const q = currentQualityRef.current;
    if (!idx?.video || !q || idx.videoUrl !== q.video_url) return; // 无索引 / 画质不匹配 → 回退顺序填充
    const vPt = lookupPoint(idx.video.points, t);
    if (!vPt) return;
    const aPt = idx.audio ? lookupPoint(idx.audio.points, t) : null;
    inSeekRef.current = true;
    // 显示已缓存的冻结帧（timeupdate 持续缓存），盖住重建 SourceBuffer 期间的黑屏
    const fc = freezeCanvasRef.current;
    if (fc) fc.style.display = "block";
    const seek: SeekPlan = {
      videoByte: vPt.byte, initEndVideo: idx.video.init_end,
      audioByte: aPt?.byte ?? 0, initEndAudio: idx.audio?.init_end ?? 0,
    };
    void play(q, t, seek).finally(() => { inSeekRef.current = false; });
  }, [play]);

  // 持续缓存最近帧到 freeze canvas（播放时 drawImage，seek 时直接显示）。
  // 不能在 'seeking' 才抓帧 —— MSE seek 到未缓冲处时浏览器会立即丢帧，抓到的是黑帧。
  useEffect(() => {
    const video = videoRef.current;
    const fc = freezeCanvasRef.current;
    if (!video || !fc) return;
    const cache = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        try {
          if (fc.width !== video.videoWidth) fc.width = video.videoWidth;
          if (fc.height !== video.videoHeight) fc.height = video.videoHeight;
          fc.getContext("2d")?.drawImage(video, 0, 0);
        } catch {
          /* 忽略（如偶发未就绪） */
        }
      }
    };
    video.addEventListener("timeupdate", cache);
    video.addEventListener("playing", cache);
    return () => {
      video.removeEventListener("timeupdate", cache);
      video.removeEventListener("playing", cache);
    };
  }, []);

  // 监听原生 seek：拖到未缓冲处 → 精准 seek
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeking = () => {
      if (inSeekRef.current) return;
      seekTo(video.currentTime);
    };
    video.addEventListener("seeking", onSeeking);
    return () => video.removeEventListener("seeking", onSeeking);
  }, [seekTo]);

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
        {/* 冻结帧 overlay：canvas 默认透明（不可见）；seek 时 drawImage 画出帧并 display:block。
            不能在 JSX 里写 style.display —— play() 的 setLoading 会触发 re-render 把它重置回默认，导致 overlay 被 React 抹掉、黑屏复发。显示态完全由 ref 控制。 */}
        <canvas
          ref={freezeCanvasRef}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
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
