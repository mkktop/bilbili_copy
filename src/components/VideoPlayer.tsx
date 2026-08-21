import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft, Loader2, AlertCircle, Settings2, Check, ListVideo, Gauge, Subtitles,
  MessageSquare, MessageSquareOff, PictureInPicture2, Minimize2, Maximize2, X, History,
  SkipForward, ListMusic, Repeat,
} from "lucide-react";
import type { VideoPage, PlaylistItem, DanmakuStyleConfig } from "../types";
import { formatDuration } from "../types";

interface Props {
  bvid: string;
  /** 稿件 aid：字幕列表 API（player v2）必填 */
  aid: number;
  cid: number;
  epId?: number;
  duration: number;
  title: string;
  /** 多分P列表：传入则在顶部显示「选集」菜单，可切换播放。单P/缺省则不显示。 */
  pages?: VideoPage[];
  /** 跨稿件播放列表（每周必看/收藏夹等）：传入后支持自动切下一集 + 列表面板。 */
  playlist?: PlaylistItem[];
  /** 播放列表起始索引（默认 0） */
  playlistIndex?: number;
  /** 弹幕渲染样式（设置页与下载 ASS 同一份配置；缺省用下方模块级默认值） */
  danmakuStyle?: DanmakuStyleConfig;
  onBack: () => void;
}

/** 字幕轨道（get_subtitle_list 返回） */
interface SubtitleTrack {
  lan: string;
  lan_doc: string;
  /** AI 自动生成字幕（很多视频只有这种） */
  is_ai: boolean;
  subtitle_url: string;
}

/** 字幕 cue（get_subtitle_cues 返回，秒） */
interface SubtitleCue {
  from: number;
  to: number;
  content: string;
}

/** 倍速档位（WebView2 原生控件不暴露倍速菜单，只能自建） */
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// ---- 弹幕渲染（canvas 覆盖层，get_danmaku_json 返回）----
interface DanmakuItem {
  /** 出现时间（秒） */
  time: number;
  text: string;
  /** 1=滚动 4=底部 5=顶部 6=逆向 */
  mode: number;
  /** hex 颜色 "#rrggbb" */
  color: string;
}
/** 预布局后的弹幕：lane<0 表示通道占满被丢弃（与官方「太密少显示几条」体验一致） */
interface LaidDanmaku extends DanmakuItem {
  lane: number;
  /** 文本像素宽（按 DM_FONT_SIZE 测量） */
  width: number;
}

const DM_FONT_SIZE = 24;
const DM_SCROLL_DUR = 12; // 滚动弹幕跨屏时长（秒）
const DM_FIXED_DUR = 5;   // 顶部/底部固定弹幕显示时长（秒）
const DM_GAP = 24;        // 同通道前后弹幕最小间距（px）
const DM_VIRTUAL_W = 1280; // 布局用虚拟画布宽（渲染时位置按实际宽度推导，轻微缩放无感）
const DM_OPACITY = 0.85;

/** 记住本会话弹幕开关（与画质/倍速同策略） */
let lastDanmakuOn = true;

/** 预布局：按时间顺序给每条弹幕分配通道。确定性布局 → seek 后位置可复现，
 *  碰撞规则与后端 ASS 布局（danmaku.rs Lane::available_for）同源简化。
 *  scrollDur/blockTop/blockBottom 来自设置（与下载 ASS 的弹幕配置同源），
 *  改变设置后重新布局即可生效。 */
function layoutDanmaku(
  items: DanmakuItem[],
  measure: (text: string) => number,
  scrollDur: number,
  blockTop: boolean,
  blockBottom: boolean
): LaidDanmaku[] {
  const scrollLanes = Array.from({ length: 14 }, () => ({ time: -1e9, width: 0 }));
  const topLanes: number[] = new Array(5).fill(-1e9);    // 通道占用截止时刻
  const bottomLanes: number[] = new Array(5).fill(-1e9);

  const placeScroll = (it: DanmakuItem, w: number): number => {
    for (let i = 0; i < scrollLanes.length; i++) {
      const lane = scrollLanes[i];
      const v1 = (DM_VIRTUAL_W + lane.width) / scrollDur;
      const v2 = (DM_VIRTUAL_W + w) / scrollDur;
      const dt = it.time - lane.time;
      const dx = v1 * dt - lane.width; // 前一条尾部已越过右边缘的距离
      if (dx < DM_GAP) continue;
      // 后一条更快时检查追尾：前一条离场前，后一条前端不能追进 GAP 内
      if (w > lane.width) {
        const pos = v2 * (scrollDur - dt);
        if (pos > DM_VIRTUAL_W - DM_GAP) continue;
      }
      scrollLanes[i] = { time: it.time, width: w };
      return i;
    }
    return -1;
  };
  const placeFixed = (it: DanmakuItem, lanes: number[]): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (it.time >= lanes[i]) {
        lanes[i] = it.time + DM_FIXED_DUR;
        return i;
      }
    }
    return -1;
  };

  return items.map((it) => {
    // 屏蔽顶/底弹幕（设置项）：直接丢弃，不占通道
    if (it.mode === 5 && blockTop) return { ...it, lane: -1, width: 0 };
    if (it.mode === 4 && blockBottom) return { ...it, lane: -1, width: 0 };
    const width = measure(it.text);
    let lane: number;
    if (it.mode === 5) lane = placeFixed(it, topLanes);
    else if (it.mode === 4) lane = placeFixed(it, bottomLanes);
    else lane = placeScroll(it, width); // mode 1/6 统一按滚动处理
    return { ...it, lane, width };
  });
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

/** 记住本会话上次手动选择的倍速，下次打开沿用 */
let lastChosenRate = 1;

/** B站流 URL → biliproxy 代理 URL（base64url 编码进路径，绕跨域 + 补 Referer）。
 *  Windows WebView2 下自定义协议地址形如 http://biliproxy.localhost/<path> */
function proxyUrl(biliUrl: string): string {
  const b64 = btoa(biliUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `http://biliproxy.localhost/b/${b64}`;
}

/** videoshot 索引（与后端 bilibili/videoshot.rs::Videoshot 对应，snake_case 序列化） */
interface Videoshot {
  images: string[];
  index: number[];
  img_x_len: number;
  img_y_len: number;
  img_x_size: number;
  img_y_size: number;
}

/** 探测本机 MSE 能解的编码，决定在线播放的编码优先级。
 *  B站的 4K/8K 流基本只有 HEVC/AV1（AVC 通常止步 1080P）：
 *  - HEVC：需要系统装 HEVC 视频扩展（硬解），isTypeSupported 为真才可用
 *  - AV1：WebView2（Chromium）自带软解，一般直接可解，但高画质软解 CPU 占用高
 *  - AVC：所有环境都支持，画质上限受 B站片源限制
 *  模块级执行一次；探测失败任何值都安全回退 AVC。 */
function probePlayerCodecs(): string[] {
  try {
    const ms = window.MediaSource;
    if (!ms || typeof ms.isTypeSupported !== "function") return ["AVC"];
    if (ms.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"')) return ["HEVC", "AVC"];
    if (ms.isTypeSupported('video/mp4; codecs="av01.0.13M.08"')) return ["AV1", "AVC"];
    return ["AVC"];
  } catch {
    return ["AVC"];
  }
}
const PLAYER_CODECS = probePlayerCodecs();

/** 时间点 → 雪碧图定位（图序号, 行, 列）。index 中 -1 是换图分隔符；超尾钳制到最后一格。 */
function locateShot(vs: Videoshot, t: number): [number, number, number] | null {
  if (!vs.images.length || !vs.img_x_len) return null;
  const stamps = vs.index.filter((v) => v >= 0);
  if (!stamps.length) return null;
  const tc = Math.min(Math.max(t, 0), Math.max(...stamps));
  let sprite = 0;
  let cell = 0;
  for (let i = 0; i < vs.index.length; i++) {
    const ts = vs.index[i];
    if (ts < 0) { sprite++; cell = 0; continue; }
    let end = Infinity;
    for (let j = i + 1; j < vs.index.length; j++) {
      if (vs.index[j] >= 0) { end = vs.index[j]; break; }
    }
    if (ts <= tc && tc < end) {
      return [sprite, Math.floor(cell / vs.img_x_len), cell % vs.img_x_len];
    }
    cell++;
  }
  return null;
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

/** 按流编码选 SourceBuffer MIME。Chromium 实际按 SPS/VVC 参数集解码，
 *  声明串只需通过 isTypeSupported 校验即可（level 偏高无害）。
 *  HEVC/AV1 探测失败回退 AVC 串——append 会失败，由上层报错。 */
function videoMimeFor(codec: string): string {
  const supported = (c: string) =>
    typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(c);
  if (codec === "HEVC") {
    for (const c of ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hvc1.1.6.L150.90"']) {
      if (supported(c)) return c;
    }
  }
  if (codec === "AV1") {
    for (const c of ['video/mp4; codecs="av01.0.13M.08"', 'video/mp4; codecs="av01.0.08M.08"']) {
      if (supported(c)) return c;
    }
  }
  return bestAvcCodec();
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
      const { buf, total: t } = await fetchWithRetry(url, start, start + CHUNK, signal);
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

/** fetch 超时：CDN 挂起不抛错时 await 永远 pending（起播/追帧 loading 卡死），
 *  15s 无进展按失败处理交给重试逻辑。与外部 abort signal 组合（任一触发即中止）。 */
function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  // 外部已中止则直接用外部（timeout 信号保持待机即可，无泄漏影响）
  const composite = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
  return composite;
}

/** fetchRange 同时返回 total（来自 content-range） */
async function fetchRangeTotal(url: string, start: number, endExclusive: number, signal?: AbortSignal): Promise<{ buf: ArrayBuffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endExclusive - 1}` }, signal: withTimeoutSignal(signal) });
  if (res.status !== 206 && res.status !== 200) throw new Error(`拉流失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const cr = res.headers.get("content-range");
  const total = cr ? parseInt(cr.split("/")[1], 10) : start + buf.byteLength;
  return { buf, total };
}

/** 带重试的分块拉取：瞬时网络抖动（代理超时 / CDN 5xx / 连接重置）自动退避重试，
 *  避免单个分块失败就中断整段播放（「播着播着流失败」的主因之一）。
 *  - abort 立即停止不重试；
 *  - HTTP 4xx（除 408/429）多为签名 URL 失效 / 风控，重试同 URL 无意义 → 直接抛出。 */
async function fetchWithRetry(
  url: string,
  start: number,
  endExclusive: number,
  signal: AbortSignal,
  retries = 4,
): Promise<{ buf: ArrayBuffer; total: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fetchRangeTotal(url, start, endExclusive, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const fatal = /HTTP 4\d\d/.test(msg) && !/HTTP (408|429)/.test(msg);
      if (fatal) throw e;
      if (attempt < retries) {
        invoke("log_player_error", { msg: `分块拉流失败(将重试 ${attempt + 1}/${retries}): ${msg}` }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // 300/600/900/1200ms 退避
      }
    }
  }
  throw lastErr;
}

/** 安全结束流：等所有 SourceBuffer 完成 updating 再 endOfStream。
 *  直接调 endOfStream 时若仍有 buffer 在 updating（最后一段 append 的内部时长 reconcile）会抛异常，
 *  即使数据已全部缓冲完也会误报「播放流加载失败」。这里监听 updateend 确保 updating=false 后再结束，
 *  并兑底 try/catch（结束失败不影响已缓冲内容的播放）。 */
function safeEndOfStream(mediaSource: MediaSource, buffers: SourceBuffer[]): void {
  if (mediaSource.readyState !== "open") return;
  let done = false;
  const tryEnd = () => {
    if (done || mediaSource.readyState !== "open") return;
    if (buffers.some((sb) => sb.updating)) {
      buffers.forEach((sb) => {
        if (sb.updating) sb.addEventListener("updateend", tryEnd, { once: true });
      });
      return;
    }
    done = true;
    try {
      mediaSource.endOfStream();
    } catch {
      /* 数据已缓冲完，结束失败不影响播放 */
    }
  };
  tryEnd();
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

export function VideoPlayer({ bvid, aid, cid, epId, duration, title, pages, playlist, playlistIndex, danmakuStyle, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // 弹幕渲染样式：优先读设置（与下载 ASS 的弹幕配置同源），缺省回退模块级默认值。
  // 样式变化会触发弹幕重新布局/重绘（见下方两个 danmaku effect 的依赖）。
  const dmStyle = {
    fontSize: danmakuStyle?.fontSize ?? DM_FONT_SIZE,
    scrollDuration: danmakuStyle?.scrollDuration ?? DM_SCROLL_DUR,
    opacity: danmakuStyle?.opacity ?? DM_OPACITY,
    blockTop: danmakuStyle?.blockTop ?? false,
    blockBottom: danmakuStyle?.blockBottom ?? false,
  };
  const dmFont = `bold ${dmStyle.fontSize}px "Microsoft YaHei", sans-serif`;
  const dmLaneH = dmStyle.fontSize + 8;

  // 播放列表模式：跨稿件连续播放。playlistIdx 追踪当前项，变化后派生 bvid/cid 等 →
  // 初始化 effect 重跑加载新稿件流（与分P切换同机制，复用 MSE 生命周期）。
  const hasPlaylist = (playlist?.length ?? 0) > 1;
  const [playlistIdx, setPlaylistIdx] = useState<number>(playlistIndex ?? 0);
  const [autoNext, setAutoNext] = useState(true); // 自动切下一集开关（本会话记忆）
  const [playlistOpen, setPlaylistOpen] = useState(false); // 播放列表面板
  const plItem = hasPlaylist ? playlist![Math.min(playlistIdx, playlist!.length - 1)] : null;

  // 有效播放参数：播放列表项优先，否则用 props（单稿件/分P 模式）
  const effBvid = plItem?.bvid ?? bvid;
  const effAid = plItem?.aid ?? aid;
  const effDuration = plItem && plItem.duration > 0 ? plItem.duration : duration;
  const effTitle = plItem?.title ?? title;
  // 播放列表模式下不使用分P（每项是独立稿件）
  const effPages = plItem ? undefined : pages;

  // 多分P：当前播放的分P（初始为 props.cid 对应的P）。切换分P → 派生值变化 →
  // 下面的初始化 effect 重跑（中断旧流、加载新分P流），复用现有 MSE 生命周期。
  // 父级每次打开播放器都是新挂载（playingItem null→对象），故初始值生效一次即可。
  const [activePage, setActivePage] = useState<VideoPage | null>(
    () => effPages?.find(p => p.cid === cid) ?? null
  );
  const currentCid = plItem ? plItem.cid : (activePage?.cid ?? cid);
  const currentDuration = plItem ? effDuration : (activePage && activePage.duration > 0 ? activePage.duration : duration);
  const currentEpId = plItem ? plItem.epId : (activePage?.ep_id ?? epId);
  const multiPage = !plItem && (effPages?.length ?? 0) > 1;
  const [qualities, setQualities] = useState<PlayQuality[]>([]);
  const [selectedQn, setSelectedQn] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // 进度条悬停缩略图预览（videoshot 雪碧图）。原生控件进度条无法挂事件，
  // 以「指针进入 video 元素底部控件条区域」近似悬停进度条，按指针 X 换算时间点。
  // 全部以 <video> 元素自身矩形为基准（而非外层容器）：原生控件条贴着 video 元素底部，
  // 竖屏等 letterbox 场景下 video 元素与容器不重合，用容器会错位。
  const [videoshot, setVideoshot] = useState<Videoshot | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{
    x: number;           // 相对 video 左缘的像素
    ratio: number;       // 0-1，换算时间
    videoLeft: number;   // video 左缘相对容器左缘（预览浮层定位用）
    bottomGap: number;   // video 底边相对容器底边（预览浮层定位用）
  } | null>(null);
  useEffect(() => {
    setVideoshot(null);
    invoke<Videoshot>("get_videoshot", { bvid: effBvid, cid: currentCid })
      .then((vs) => { if (vs.images.length) setVideoshot(vs); })
      .catch(() => { /* 无索引的视频静默跳过 */ });
  }, [effBvid, currentCid]);
  const onAreaPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !videoshot) return;
    const vr = video.getBoundingClientRect();
    const cr = e.currentTarget.getBoundingClientRect();
    // WebView2 原生控件条高约 48px：指针在其范围内才显示
    if (e.clientY < vr.bottom - 52 || e.clientY < cr.top || e.clientY > cr.bottom || e.clientX < cr.left || e.clientX > cr.right) {
      setHoverPreview(null);
      return;
    }
    const x = Math.min(Math.max(e.clientX - vr.left, 0), vr.width);
    setHoverPreview({
      x,
      ratio: x / vr.width,
      videoLeft: vr.left - cr.left,
      bottomGap: cr.bottom - vr.bottom,
    });
  };
  const onAreaPointerLeave = () => setHoverPreview(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [episodeMenuOpen, setEpisodeMenuOpen] = useState(false); // 分P选集菜单
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);     // 倍速菜单
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false); // 字幕菜单
  // 倍速：模块级记忆 + 每次 src 重建后重设（赋 src 会触发媒体加载算法把 playbackRate 复位）
  const [playbackRate, setPlaybackRate] = useState(lastChosenRate);
  // 字幕：轨道列表（随 bvid/cid 拉取）+ 选中轨道的 cues + 当前显示文本
  const [subTracks, setSubTracks] = useState<SubtitleTrack[]>([]);
  const [selectedSubLan, setSelectedSubLan] = useState<string | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [activeCue, setActiveCue] = useState("");
  const cueReqRef = useRef(0); // cues 请求序号：丢弃过期响应（快速切轨道/切P）
  // 弹幕：本会话开关记忆 + 预布局列表（ref 持有，rAF 直绘不走 React state）
  const [danmakuOn, setDanmakuOn] = useState(lastDanmakuOn);
  const [danmakuCount, setDanmakuCount] = useState(0); // 已加载弹幕数（0=未加载/无弹幕 → 按钮禁用）
  const danmakuListRef = useRef<LaidDanmaku[]>([]);
  const danmakuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dmReqRef = useRef(0); // 弹幕请求序号：切P时丢弃过期响应
  // 迷你窗口模式（应用内小窗；系统级悬浮用画中画 PiP）
  const [miniMode, setMiniMode] = useState(false);
  // 续播：上次看到的位置（秒），非 null 时显示「继续观看」提示条
  const [resumeHint, setResumeHint] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); // 根容器：F 全屏对象（含弹幕/字幕覆盖层）
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

  /** 顶栏四个下拉菜单（选集/画质/倍速/字幕）互斥 */
  const closeMenus = useCallback(() => {
    setMenuOpen(false);
    setEpisodeMenuOpen(false);
    setSpeedMenuOpen(false);
    setSubtitleMenuOpen(false);
  }, []);

  /** 应用倍速：记忆 + 立即生效（defaultPlaybackRate 保证后续 src 重建也沿用） */
  const applySpeed = useCallback((rate: number) => {
    lastChosenRate = rate;
    setPlaybackRate(rate);
    closeMenus();
    const video = videoRef.current;
    if (video) {
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    }
  }, [closeMenus]);

  /** 字幕列表：随 bvid/cid 变化重拉（切P换轨道）；画质切换不重置（同 cid 同内容，保留用户选择）。
   *  无字幕/未登录 → 空列表 → 菜单禁用。 */
  useEffect(() => {
    let active = true;
    cueReqRef.current++; // 切P/换稿件：让上一P在途的 get_subtitle_cues 响应过期（其 req 不再等于当前值）
    setSubTracks([]);
    setSelectedSubLan(null);
    setCues([]);
    setActiveCue("");
    invoke<SubtitleTrack[]>("get_subtitle_list", { bvid: effBvid, cid: currentCid, aid: effAid })
      .then((list) => { if (active) setSubTracks(list); })
      .catch(() => { /* 无字幕或异常：菜单禁用即可，不打断播放 */ });
    return () => { active = false; };
  }, [effBvid, currentCid, effAid]);

  /** 选择字幕轨道：null = 关闭。cues 拉取按序号丢弃过期响应。 */
  const selectSubtitle = useCallback(async (lan: string | null) => {
    closeMenus();
    setSelectedSubLan(lan);
    if (!lan) {
      cueReqRef.current++;
      setCues([]);
      setActiveCue("");
      return;
    }
    const track = subTracks.find((t) => t.lan === lan);
    if (!track) return;
    const req = ++cueReqRef.current;
    try {
      const list = await invoke<SubtitleCue[]>("get_subtitle_cues", { subtitleUrl: track.subtitle_url });
      if (cueReqRef.current === req) setCues(list);
    } catch {
      if (cueReqRef.current === req) {
        setCues([]);
        setSelectedSubLan(null);
        setActiveCue(""); // 与「关闭」分支一致：失败时也不能留下上一轨的残影字幕
      }
    }
  }, [subTracks, closeMenus]);

  /** 当前 cue 显示：timeupdate（~4Hz）线性扫描。无 op 时不 setState（防无谓重渲染）。 */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || cues.length === 0) {
      setActiveCue((p) => (p ? "" : p)); // 防御：cues 清空路径若漏清 activeCue，这里兜底
      return;
    }
    const onTime = () => {
      const t = video.currentTime;
      const cue = cues.find((c) => t >= c.from && t < c.to);
      const text = cue?.content ?? "";
      setActiveCue((prev) => (prev === text ? prev : text));
    };
    video.addEventListener("timeupdate", onTime);
    onTime();
    return () => video.removeEventListener("timeupdate", onTime);
  }, [cues]);

  /** 弹幕列表：随 bvid/cid 变化重拉（切P换弹幕；画质切换不重拉）。
   *  拉取后一次性预布局（确定性通道分配），rAF 渲染时只按时间窗口查表直绘。
   *  无弹幕/未登录 → 空列表 → 开关按钮禁用。 */
  useEffect(() => {
    const req = ++dmReqRef.current;
    let active = true; // 卸载守卫：组件卸载后不再 setState（与字幕 effect 写法一致）
    danmakuListRef.current = [];
    setDanmakuCount(0);
    invoke<DanmakuItem[]>("get_danmaku_json", { cid: currentCid, aid: effAid, duration: currentDuration })
      .then((list) => {
        if (!active || dmReqRef.current !== req) return;
        // 离屏 canvas 测量文本宽（与渲染字体一致，保证碰撞布局准确）
        const ctx = document.createElement("canvas").getContext("2d");
        if (!ctx) return;
        ctx.font = dmFont;
        const laid = layoutDanmaku(list, (t) => ctx.measureText(t).width, dmStyle.scrollDuration, dmStyle.blockTop, dmStyle.blockBottom).filter((d) => d.lane >= 0);
        danmakuListRef.current = laid;
        setDanmakuCount(laid.length);
      })
      .catch(() => { /* 无弹幕或异常：按钮禁用即可，不打断播放 */ });
    return () => { active = false; };
  }, [effBvid, currentCid, effAid, currentDuration, dmFont, dmStyle.scrollDuration, dmStyle.blockTop, dmStyle.blockBottom]);

  /** 弹幕渲染：rAF 循环直绘 canvas（不走 React state，避免高频重渲染）。
   *  开关关闭/无弹幕时清屏并停表；暂停时画面静止（currentTime 不变）。 */
  useEffect(() => {
    const canvas = danmakuCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!danmakuOn || danmakuCount === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (W === 0 || H === 0) return;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      ctx.clearRect(0, 0, W, H);
      const list = danmakuListRef.current;
      if (list.length === 0) return;
      const t = video.currentTime;
      ctx.font = dmFont;
      ctx.textBaseline = "top";
      ctx.globalAlpha = dmStyle.opacity;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      // 二分找第一条可能在屏的弹幕（列表按 time 升序；窗口取滚动/固定时长较大者）
      const win = Math.max(dmStyle.scrollDuration, DM_FIXED_DUR);
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].time <= t - win) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < list.length; i++) {
        const d = list[i];
        if (d.time > t) break;
        const age = t - d.time;
        let x: number, y: number;
        if (d.mode === 5 || d.mode === 4) {
          if (age > DM_FIXED_DUR) continue;
          x = (W - d.width) / 2;
          y = d.mode === 5 ? 8 + d.lane * dmLaneH : H - 8 - (d.lane + 1) * dmLaneH;
        } else {
          if (age > dmStyle.scrollDuration) continue;
          // 碰撞布局按虚拟宽 1280 计算，渲染按实际宽度推导位置：同通道速度同比缩放，重叠风险可忽略
          x = W - (age / dmStyle.scrollDuration) * (W + d.width);
          if (x + d.width < 0 || x > W) continue;
          y = 8 + d.lane * dmLaneH;
        }
        if (y < 0 || y + dmStyle.fontSize > H) continue; // 迷你窗口等矮容器：超出可视区的通道直接不画
        ctx.strokeText(d.text, x, y);
        ctx.fillStyle = d.color;
        ctx.fillText(d.text, x, y);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [danmakuOn, danmakuCount, dmFont, dmLaneH, dmStyle.opacity, dmStyle.scrollDuration]);

  /** 弹幕开关：本会话记忆（与画质/倍速同策略） */
  const toggleDanmaku = useCallback(() => {
    setDanmakuOn((prev) => { lastDanmakuOn = !prev; return !prev; });
  }, []);

  /** 系统画中画：WebView2(Chromium) 原生 PiP，小窗置顶悬浮于所有应用之上。
   *  弹幕/字幕是 DOM 覆盖层，不会进入 PiP 小窗（原生限制）。 */
  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const doc = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
      if (doc.pictureInPictureElement) await doc.exitPictureInPicture?.();
      else await (video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }).requestPictureInPicture?.();
    } catch { /* webview 不支持或被拒绝：静默 */ }
  }, []);

  /** 快捷键：空格 播放/暂停，←/→ 快退快进 5s，↑/↓ 音量，M 静音，D 弹幕，F 全屏，Esc 关菜单/退出 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      // 输入类控件聚焦时不拦截（当前播放器无输入框，防御未来扩展）
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
          e.preventDefault(); // 阻止滚动/聚焦按钮被空格重复触发
          if (video.paused) void video.play().catch(() => {});
          else video.pause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          video.currentTime = Math.min(video.duration || currentDuration, video.currentTime + 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case "m": case "M":
          video.muted = !video.muted;
          break;
        case "d": case "D":
          toggleDanmaku();
          break;
        case "f": case "F": {
          // 全屏切换：全屏根容器（含弹幕/字幕覆盖层），而非只全屏 video
          const el = containerRef.current;
          if (!el) break;
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          else void el.requestFullscreen().catch(() => {});
          break;
        }
        case "Escape":
          // 菜单开着先关菜单；原生全屏的 Esc 由 webview 先消费；否则退出播放器
          if (menuOpen || episodeMenuOpen || speedMenuOpen || subtitleMenuOpen) closeMenus();
          else if (!document.fullscreenElement) onBack();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDanmaku, closeMenus, onBack, currentDuration, menuOpen, episodeMenuOpen, speedMenuOpen, subtitleMenuOpen]);


  /** 续播提示：打开/切P 时查上次进度，>5s 则显示提示条（12s 无操作自动隐藏）。
   *  不自动 seek：避免精准 seek 索引未就绪时的启动竞态，由用户点击触发（与 B站 web 端一致）。 */
  useEffect(() => {
    let active = true;
    setResumeHint(null);
    invoke<number | null>("get_play_progress", { cid: currentCid })
      .then((pos) => {
        if (active && pos != null && pos > 5) setResumeHint(pos);
      })
      .catch(() => { /* 进度读取失败不影响播放 */ });
    const hide = setTimeout(() => { if (active) setResumeHint(null); }, 12000);
    return () => { active = false; clearTimeout(hide); };
  }, [currentCid]);

  /** 进度保存：timeupdate 每 5s 节流落库；关闭/切P 时补存一次。
   *  看到接近结尾时后端自动删记录（下次从头播）。 */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let lastSave = 0;
    const save = () => {
      const t = video.currentTime;
      if (t < 5) return; // 刚开头不值得记
      invoke("save_play_progress", {
        cid: currentCid, bvid: effBvid, position: t, duration: Math.round(currentDuration),
      }).catch(() => {});
    };
    const onTime = () => {
      const now = Date.now();
      if (now - lastSave < 5000) return;
      lastSave = now;
      save();
    };
    video.addEventListener("timeupdate", onTime);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      save(); // 卸载/切P 补存，保证退出时进度不丢
    };
  }, [effBvid, currentCid, currentDuration]);

  /** 点击续播：原生 seek 到记忆位置（未缓冲处由既有 seeking 监听触发精准 seek） */
  const resumePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || resumeHint == null) return;
    video.currentTime = resumeHint;
    setResumeHint(null);
  }, [resumeHint]);

  /** 播放列表：切到指定索引（清 freeze canvas 残留帧，派生值变化 → 初始化 effect 重跑） */
  const gotoPlaylistItem = useCallback((idx: number) => {
    if (!hasPlaylist) return;
    const clamped = Math.max(0, Math.min(idx, playlist!.length - 1));
    const fc = freezeCanvasRef.current;
    if (fc) {
      fc.style.display = "none";
      try { fc.getContext("2d")?.clearRect(0, 0, fc.width, fc.height); } catch { /* 忽略 */ }
    }
    setActivePage(null); // 播放列表项是独立稿件，清掉分P状态
    setPlaylistIdx(clamped);
  }, [hasPlaylist, playlist]);

  /** 播放列表：下一集（末尾则停） */
  const nextPlaylistItem = useCallback(() => {
    if (!hasPlaylist) return;
    if (playlistIdx < playlist!.length - 1) gotoPlaylistItem(playlistIdx + 1);
  }, [hasPlaylist, playlist, playlistIdx, gotoPlaylistItem]);

  /** 播放结束：播放列表模式且 autoNext 开启 → 自动切下一集 */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => {
      if (hasPlaylist && autoNext && playlistIdx < playlist!.length - 1) {
        gotoPlaylistItem(playlistIdx + 1);
      }
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [hasPlaylist, autoNext, playlistIdx, playlist, gotoPlaylistItem]);

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

    const videoMime = videoMimeFor(quality.codec);
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
    // 赋 src 触发媒体加载算法会把 playbackRate 复位为 defaultPlaybackRate：两者一起重设，
    // 保证画质切换 / 精准 seek 重建流后倍速不丢。
    video.defaultPlaybackRate = lastChosenRate;
    video.playbackRate = lastChosenRate;
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

        // 设置媒体时长：MSE 默认 duration=Infinity，原生控件会当成「直播流」→
        // 进度条不显示、右端无总时长、加载期无可拖动范围。设为已知时长后，
        // 加载阶段即显示完整时间轴，进度条与可拖动范围立即可见。
        try { if (currentDuration > 0) mediaSource.duration = currentDuration; } catch { /* 个别 webview 拒绝则忽略 */ }

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
        if (!cancelledRef.current && !ac.signal.aborted) {
          // 安全结束：等所有 buffer 完成 updating 再 endOfStream，避免「updating is true」误报流失败
          const endBuffers: SourceBuffer[] = asb ? [vsb, asb] : [vsb];
          safeEndOfStream(mediaSource, endBuffers);
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
  }, [reportError, loadSeekIndex, currentDuration]);

  // 初次加载：取画质列表 → 选默认画质 → 打开
  useEffect(() => {
    let active = true;
    cancelledRef.current = false;
    (async () => {
      try {
        const streams = await invoke<PlayStreams>("get_play_streams", {
          bvid: effBvid, cid: currentCid, epId: currentEpId ?? null, duration: currentDuration,
          codecs: PLAYER_CODECS,
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
  }, [effBvid, currentCid, currentEpId, currentDuration, play, reportError]);

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

  /** 分P 切换：更新当前分P → 派生 cid/duration 变化 → 初始化 effect 重跑加载新流。
   *  顺手清掉 freeze canvas 上一P的残留帧，避免新分P canplay 前被旧帧盖住。 */
  const switchPage = useCallback((p: VideoPage) => {
    setEpisodeMenuOpen(false);
    setMenuOpen(false);
    if (p.cid === activePage?.cid) return;
    const fc = freezeCanvasRef.current;
    if (fc) {
      fc.style.display = "none";
      try { fc.getContext("2d")?.clearRect(0, 0, fc.width, fc.height); } catch { /* 忽略 */ }
    }
    setActivePage(p);
  }, [activePage?.cid]);

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
    <div
      ref={containerRef}
      className={
        miniMode
          ? "fixed bottom-4 right-4 z-[70] w-[480px] max-w-[60vw] rounded-xl overflow-hidden shadow-2xl border border-white/15 bg-black flex flex-col"
          : "fixed inset-0 z-[70] bg-black flex flex-col"
      }
    >
      {/* 迷你模式顶栏：还原 + 标题 + 关闭（完整菜单栏隐藏；video 元素不重建，MSE 流不中断） */}
      {miniMode && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-900/95 border-b border-white/10">
          <button
            onClick={() => setMiniMode(false)}
            title="还原"
            className="p-1.5 rounded-lg text-white hover:bg-white/10 transition-colors"
          >
            <Maximize2 size={14} />
          </button>
          <h1 className="text-xs font-medium text-white truncate flex-1">{effTitle}</h1>
          <button
            onClick={onBack}
            title="关闭"
            className="p-1.5 rounded-lg text-white hover:bg-white/10 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 顶部：返回 + 标题 + 选集/画质/倍速/字幕/弹幕/画中画/迷你 */}
      {!miniMode && (
      <div className="relative z-30 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={onBack} className="p-2 rounded-lg text-white hover:bg-white/10 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-sm font-medium text-white truncate flex-1">{effTitle}</h1>

        {/* 分P选集（多分P才显示） */}
        {multiPage && effPages && (
          <div className="relative">
            <button
              onClick={() => { const next = !episodeMenuOpen; closeMenus(); setEpisodeMenuOpen(next); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors"
            >
              <ListVideo size={15} />
              <span>{activePage ? `P${activePage.page}` : "选集"}</span>
            </button>
            {episodeMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setEpisodeMenuOpen(false)} />
                <div className="absolute right-0 top-full z-30 mt-1 min-w-[200px] max-w-[320px] rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl py-1 max-h-[60vh] overflow-auto">
                  {effPages.map(p => (
                    <button
                      key={p.page}
                      onClick={() => switchPage(p)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-white/50 shrink-0">P{p.page}</span>
                        <span className="truncate">{p.part}</span>
                      </span>
                      {p.cid === currentCid && <Check size={14} className="text-emerald-400 shrink-0" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 画质选择 */}
        <div className="relative">
          <button
            onClick={() => { const next = !menuOpen; closeMenus(); setMenuOpen(next); }}
            disabled={qualities.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40"
          >
            <Settings2 size={15} />
            <span>{currentLabel}</span>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[150px] rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl py-1 max-h-[60vh] overflow-auto">
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

        {/* 倍速（WebView2 原生控件无倍速菜单，自建） */}
        <div className="relative">
          <button
            onClick={() => { const next = !speedMenuOpen; closeMenus(); setSpeedMenuOpen(next); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors"
          >
            <Gauge size={15} />
            <span>{playbackRate === 1 ? "倍速" : `${playbackRate}x`}</span>
          </button>
          {speedMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={closeMenus} />
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[110px] rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl py-1">
                {SPEED_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => applySpeed(rate)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                  >
                    <span>{rate === 1 ? "正常" : `${rate}x`}</span>
                    {rate === playbackRate && <Check size={14} className="text-emerald-400" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 字幕（无轨道时禁用；AI 字幕带标注） */}
        <div className="relative">
          <button
            onClick={() => { const next = !subtitleMenuOpen; closeMenus(); setSubtitleMenuOpen(next); }}
            disabled={subTracks.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40"
          >
            <Subtitles size={15} />
            <span>
              {selectedSubLan
                ? (subTracks.find((t) => t.lan === selectedSubLan)?.lan_doc ?? "字幕")
                : "字幕"}
            </span>
          </button>
          {subtitleMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={closeMenus} />
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl py-1 max-h-[60vh] overflow-auto">
                <button
                  onClick={() => selectSubtitle(null)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                >
                  <span>关闭</span>
                  {!selectedSubLan && <Check size={14} className="text-emerald-400" />}
                </button>
                {subTracks.map((t) => (
                  <button
                    key={t.lan}
                    onClick={() => selectSubtitle(t.lan)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      {t.lan_doc}
                      {t.is_ai && <span className="text-[10px] text-white/40 border border-white/20 rounded px-1">AI</span>}
                    </span>
                    {t.lan === selectedSubLan && <Check size={14} className="text-emerald-400" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 弹幕开关（无弹幕时禁用；快捷键 D） */}
        <button
          onClick={toggleDanmaku}
          disabled={danmakuCount === 0}
          title={danmakuOn ? `关闭弹幕（${danmakuCount} 条）` : `开启弹幕（${danmakuCount} 条）`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40"
        >
          {danmakuOn ? <MessageSquare size={15} /> : <MessageSquareOff size={15} />}
          <span>弹幕</span>
        </button>

        {/* 播放列表模式：自动连播开关 + 列表面板（仅播放列表场景显示） */}
        {hasPlaylist && (
          <>
            <button
              onClick={() => setAutoNext((v) => !v)}
              title={autoNext ? "自动连播：开（点击关闭）" : "自动连播：关（点击开启）"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                autoNext ? "text-emerald-300 bg-emerald-500/20 hover:bg-emerald-500/30" : "text-white bg-white/10 hover:bg-white/20"
              }`}
            >
              <Repeat size={15} />
              <span>连播</span>
            </button>
            <button
              onClick={() => setPlaylistOpen((v) => !v)}
              title="播放列表"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                playlistOpen ? "text-pink-300 bg-pink-500/20 hover:bg-pink-500/30" : "text-white bg-white/10 hover:bg-white/20"
              }`}
            >
              <ListMusic size={15} />
              <span>{playlistIdx + 1}/{playlist!.length}</span>
            </button>
          </>
        )}

        {/* 系统画中画（置顶小窗悬浮于所有应用之上） */}
        <button
          onClick={togglePip}
          title="画中画"
          className="p-2 rounded-lg text-white bg-white/10 hover:bg-white/20 transition-colors"
        >
          <PictureInPicture2 size={15} />
        </button>

        {/* 迷你窗口（应用内右下角小窗，可边看边浏览其他页面） */}
        <button
          onClick={() => { closeMenus(); setMiniMode(true); }}
          title="迷你窗口"
          className="p-2 rounded-lg text-white bg-white/10 hover:bg-white/20 transition-colors"
        >
          <Minimize2 size={15} />
        </button>
      </div>
      )}

      {/* 视频区。min-h-0 关键：flex 子项默认 min-height:auto 不允许收缩，
          竖屏视频原生很高会把本区撑到视口外，导致下半部分被裁掉看不到。
          迷你模式改为固定 16:9 高度。 */}
      <div
        className={miniMode
          ? "h-[270px] flex items-center justify-center relative overflow-hidden"
          : "flex-1 min-h-0 flex items-center justify-center relative overflow-hidden"}
        onPointerMove={onAreaPointerMove}
        onPointerLeave={onAreaPointerLeave}
      >
        <video ref={videoRef} controls autoPlay className="max-w-full max-h-full object-contain" />
        {/* 进度条悬停缩略图：雪碧图经 biliproxy 加载（补 Referer），按定位裁出单格。
            定位以 video 元素为准：bottomGap 距容器底 + 52px 恰好悬在原生控件条上方；
            左右钳制在 video 显示范围内。pointer-events-none 不挡原生控件。 */}
        {hoverPreview && videoshot && (() => {
          const t = hoverPreview.ratio * currentDuration;
          const loc = locateShot(videoshot, t);
          if (!loc) return null;
          const [sprite, row, col] = loc;
          const img = videoshot.images[sprite];
          if (!img) return null;
          const half = videoshot.img_x_size / 2;
          const style: React.CSSProperties = {
            left: `calc(${hoverPreview.videoLeft}px + min(max(${hoverPreview.x}px, ${half}px), calc(100% - ${hoverPreview.videoLeft}px - ${half}px)))`,
            bottom: hoverPreview.bottomGap + 52,
            width: videoshot.img_x_size,
            height: videoshot.img_y_size,
            backgroundImage: `url(${proxyUrl(img)})`,
            backgroundSize: `${videoshot.img_x_len * videoshot.img_x_size}px ${videoshot.img_y_len * videoshot.img_y_size}px`,
            backgroundPosition: `-${col * videoshot.img_x_size}px -${row * videoshot.img_y_size}px`,
          };
          return (
            <div className="absolute -translate-x-1/2 z-20 pointer-events-none rounded-md overflow-hidden shadow-lg border border-white/20" style={style}>
              <span className="absolute bottom-0 right-0 px-1 text-[10px] text-white bg-black/70 rounded-tl">
                {formatDuration(Math.floor(t))}
              </span>
            </div>
          );
        })()}
        {/* 冻结帧 overlay：canvas 默认透明（不可见）；seek 时 drawImage 画出帧并 display:block。
            不能在 JSX 里写 style.display —— play() 的 setLoading 会触发 re-render 把它重置回默认，导致 overlay 被 React 抹掉、黑屏复发。显示态完全由 ref 控制。 */}
        <canvas
          ref={freezeCanvasRef}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
        {/* 弹幕覆盖层：rAF 直绘 canvas（显示内容完全由渲染 effect 控制，不走 React state）。
            盖在冻结帧之上、字幕（z-10）之下；pointer-events-none 保证原生控件可点。 */}
        <canvas
          ref={danmakuCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
        {/* 字幕覆盖层：pointer-events-none 保证原生控件可点；bottom-[8%] 避开底部控件条。
            React state 驱动安全（与 canvas 不同，无 ref 控制的 display 状态）。 */}
        {activeCue && (
          <div className="absolute bottom-[8%] left-1/2 -translate-x-1/2 z-10 pointer-events-none max-w-[80%] text-center">
            <span className="inline-block px-3 py-1 rounded bg-black/60 text-white text-base leading-relaxed whitespace-pre-wrap">
              {activeCue}
            </span>
          </div>
        )}
        {/* 续播提示条：左下角浮层，避开底部原生控件；点主体续播，点 X 关闭 */}
        {resumeHint != null && !loading && (
          <div className="absolute left-4 bottom-[14%] z-20 flex items-center gap-1 rounded-lg bg-black/75 border border-white/20 text-white text-xs overflow-hidden">
            <button
              onClick={resumePlayback}
              className="flex items-center gap-1.5 pl-3 pr-1.5 py-2 hover:bg-white/10 transition-colors"
            >
              <History size={13} className="shrink-0" />
              <span>上次看到 {formatDuration(Math.floor(resumeHint))}，点击续播</span>
            </button>
            <button
              onClick={() => setResumeHint(null)}
              className="p-2 hover:bg-white/10 transition-colors"
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
        )}
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

        {/* 播放列表面板：右侧浮层，列出全部稿件，点击切集；当前项高亮 */}
        {hasPlaylist && playlistOpen && (
          <div className="absolute top-0 right-0 bottom-0 z-30 w-[320px] max-w-[80%] bg-zinc-900/95 border-l border-white/10 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10">
              <span className="text-sm font-medium text-white">播放列表（{playlist!.length}）</span>
              <button onClick={() => setPlaylistOpen(false)} className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors">
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-auto py-1">
              {playlist!.map((item, idx) => (
                <button
                  key={`${item.bvid}-${idx}`}
                  onClick={() => { gotoPlaylistItem(idx); setPlaylistOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                    idx === playlistIdx ? "bg-pink-500/20" : "hover:bg-white/5"
                  }`}
                >
                  <span className={`w-5 text-center text-xs shrink-0 ${idx === playlistIdx ? "text-pink-300 font-bold" : "text-white/40"}`}>
                    {idx === playlistIdx ? <SkipForward size={12} className="inline" /> : idx + 1}
                  </span>
                  {item.cover && (
                    <img src={item.cover} alt="" className="w-14 h-9 rounded object-cover bg-white/10 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className={`block text-xs leading-snug line-clamp-2 ${idx === playlistIdx ? "text-pink-200" : "text-white/80"}`}>
                      {item.title}
                    </span>
                    {item.upper_name && (
                      <span className="block text-[10px] text-white/40 mt-0.5 truncate">{item.upper_name}</span>
                    )}
                  </span>
                  {item.duration > 0 && (
                    <span className="text-[10px] text-white/40 shrink-0">{formatDuration(item.duration)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
