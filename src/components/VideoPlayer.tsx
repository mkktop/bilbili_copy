import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Loader2, AlertCircle } from "lucide-react";

interface Props {
  bvid: string;
  cid: number;
  epId?: number;
  duration: number;
  title: string;
  onBack: () => void;
}

interface PlayStreams {
  video_url: string;
  audio_url: string;
  has_audio: boolean;
  video_qn: number;
  duration: number;
}

/** B站流 URL → biliproxy 代理 URL（base64url 编码进路径，绕跨域 + 补 Referer）。
 *  Windows WebView2 下自定义协议地址形如 http://biliproxy.localhost/<path> */
function proxyUrl(biliUrl: string): string {
  const b64 = btoa(biliUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `http://biliproxy.localhost/b/${b64}`;
}

/** 等待 SourceBuffer 完成上一次 append（appendBuffer 期间不能再 append） */
function waitUpdate(sb: SourceBuffer): Promise<void> {
  return new Promise((res) => sb.addEventListener("updateend", () => res(), { once: true }));
}

const AHEAD_S = 30; // 最多缓冲到当前播放点之前 30 秒（够了就暂停拉取，随播放推进再续）
const BEHIND_S = 10; // 保留当前播放点之后 10 秒，更早的回收，释放 SourceBuffer 空间

/** 当前播放点之后的已缓冲秒数（取包含 currentTime 的那段；video.buffered 是各 SourceBuffer 的交集） */
function bufferedAhead(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
      return video.buffered.end(i) - t;
    }
  }
  return 0;
}

/** 等到「前方缓冲不足」或被取消时 resolve（节奏跟随播放，避免下太快撑爆 SourceBuffer） */
function waitForNeed(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve();
      if (bufferedAhead(video) < AHEAD_S) return resolve();
      setTimeout(tick, 500);
    };
    tick();
  });
}

/** 按播放进度边下边播：前方缓冲不足才取下一块；回收已播放段防止 SourceBuffer 撑满 */
async function feedStream(
  url: string,
  sb: SourceBuffer,
  video: HTMLVideoElement,
  signal: AbortSignal
): Promise<void> {
  let start = 0;
  let total = Infinity;
  const CHUNK = 2 * 1024 * 1024; // 2MB / 块
  while (start < total) {
    await waitForNeed(video, signal);
    if (signal.aborted) return;
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + CHUNK - 1}` }, signal });
    if (res.status !== 206 && res.status !== 200) throw new Error(`拉流失败 HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return;
    const cr = res.headers.get("content-range");
    total = cr ? parseInt(cr.split("/")[1], 10) : start + buf.byteLength;
    if (sb.updating) await waitUpdate(sb);
    sb.appendBuffer(buf);
    await waitUpdate(sb);
    start += buf.byteLength;
    // 回收已播放段，释放 SourceBuffer 空间（长视频关键：否则几百 MB 会撑爆配额）
    if (video.currentTime > BEHIND_S + 5) {
      try {
        if (sb.updating) await waitUpdate(sb);
        sb.remove(0, video.currentTime - BEHIND_S);
        await waitUpdate(sb);
      } catch {
        /* 偶发 remove 失败忽略 */
      }
    }
  }
}

export function VideoPlayer({ bvid, cid, epId, duration, title, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;
    // 前端错误回传 app.log（控制台错误默认不落盘，便于后端日志统一排查）
    const reportError = (msg: string) => {
      invoke("log_player_error", { msg }).catch(() => {});
      if (!cancelled) setError(msg);
    };

    (async () => {
      try {
        // 1. 取在线播放流（后端强制 H.264/AVC）
        const streams = await invoke<PlayStreams>("get_play_streams", {
          bvid, cid, epId: epId ?? null, duration,
        });
        if (cancelled) return;
        if (!streams.video_url) throw new Error("未取到视频流地址（可能需要登录或遇到风控）");

        // 2. 检查 MSE 支持
        const videoMime = 'video/mp4; codecs="avc1.42E01E"';
        const audioMime = 'audio/mp4; codecs="mp4a.40.2"';
        if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(videoMime)) {
          throw new Error("当前 WebView 不支持 MSE 播放");
        }

        // 3. MediaSource 接管 <video>
        const video = videoRef.current;
        if (!video) return;
        const mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        video.src = objectUrl;
        // 有足够数据可播时隐藏 loading（边下边播，无需等全部下完）
        const onCanPlay = () => { if (!cancelled) setLoading(false); };
        video.addEventListener("canplay", onCanPlay, { once: true });
        video.addEventListener("playing", onCanPlay, { once: true });

        mediaSource.addEventListener("sourceopen", async () => {
          try {
            const vsb = mediaSource.addSourceBuffer(videoMime);
            const asb = streams.has_audio && streams.audio_url && MediaSource.isTypeSupported(audioMime)
              ? mediaSource.addSourceBuffer(audioMime)
              : null;
            // 视频、音频并行拉取 append；MSE 负责时间轴同步
            const tasks: Promise<void>[] = [feedStream(proxyUrl(streams.video_url), vsb, video, ac.signal)];
            if (asb) tasks.push(feedStream(proxyUrl(streams.audio_url), asb, video, ac.signal));
            await Promise.all(tasks);
            if (!cancelled && mediaSource.readyState === "open") mediaSource.endOfStream();
          } catch (e) {
            reportError(`播放流加载失败：${e instanceof Error ? e.message : String(e)}`);
          } finally {
            if (!cancelled) setLoading(false);
          }
        }, { once: true });
      } catch (e) {
        reportError(e instanceof Error ? e.message : String(e));
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bvid, cid, epId, duration]);

  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col">
      {/* 顶部：返回 + 标题 */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={onBack} className="p-2 rounded-lg text-white hover:bg-white/10 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-sm font-medium text-white truncate flex-1">{title}</h1>
      </div>

      {/* 视频区 */}
      <div className="flex-1 flex items-center justify-center relative">
        <video ref={videoRef} controls autoPlay className="max-w-full max-h-full" />
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
