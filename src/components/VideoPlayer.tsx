import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Loader2, AlertCircle, X, History, Repeat, PanelRight, Expand, Minimize2, RefreshCw, Play } from "lucide-react";
import type { VideoPage, PlaylistItem, DanmakuStyleConfig, ParsedVideoInfo, VideoListItem } from "../types";
import { formatDuration } from "../types";
import { PlayerControls } from "./player/PlayerControls";
import { PlayerDetails } from "./player/PlayerDetails";
import "./player/player.css";

interface Props {
  bvid: string;
  /** 稿件 aid：字幕列表 API（player v2）必填 */
  aid: number;
  cid: number;
  epId?: number;
  duration: number;
  title: string;
  /** 多分P列表：在侧栏切换播放，支持自动下一集。 */
  pages?: VideoPage[];
  /** 跨稿件播放列表（每周必看/收藏夹等）：传入后支持自动切下一集 + 列表面板。 */
  playlist?: PlaylistItem[];
  /** 播放列表起始索引（默认 0） */
  playlistIndex?: number;
  /** 弹幕渲染样式（设置页与下载 ASS 同一份配置；缺省用下方模块级默认值） */
  danmakuStyle?: DanmakuStyleConfig;
  videoInfo?: ParsedVideoInfo;
  onDownload?: (info: ParsedVideoInfo, page: VideoPage) => Promise<boolean>;
  onOpenRelated?: (bvid: string) => void;
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
function waitForBuffered(video: HTMLVideoElement, target: number, signal: AbortSignal, requireFrame = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const finish = (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    const tick = () => {
      if (signal.aborted) return finish();
      if (!requireFrame || video.readyState >= 2) for (let i = 0; i < video.buffered.length; i++) {
        // 带 B 帧/编码延迟的片源可能从 0.1–0.2s 开始，并不精确覆盖 0。
        const start = video.buffered.start(i);
        if ((target === 0 && start < 1) || (start <= target + .05 && target < video.buffered.end(i))) return finish();
      }
      if (Date.now() - started > 30000) return finish(new Error("等待视频缓冲超时，请重试或选择较低画质"));
      timer = setTimeout(tick, 100);
    };
    signal.addEventListener("abort", abort, { once: true }); tick();
  });
}

export function VideoPlayer({ bvid, aid, cid, epId, duration, title, pages, playlist, playlistIndex, danmakuStyle, videoInfo, onDownload, onOpenRelated, onBack }: Props) {
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

  const hasPlaylist = (playlist?.length ?? 0) > 1;
  const [playlistIdx, setPlaylistIdx] = useState(playlistIndex ?? 0);
  const [autoNext, setAutoNext] = useState(true);
  const [playlistOpen, setPlaylistOpen] = useState(() => window.innerWidth > 900);
  const [sideTab, setSideTab] = useState<"episodes" | "related">("episodes");
  const [theater, setTheater] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsActive, setControlsActive] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [notice, setNotice] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [closeMenuSignal, setCloseMenuSignal] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const retryRef = useRef<{ bvid: string; cid: number; time: number; playing: boolean } | null>(null);
  const desiredPlayingRef = useRef(true);
  const plItem = hasPlaylist ? playlist![Math.min(playlistIdx, playlist!.length - 1)] : null;
  const [activePage, setActivePage] = useState<VideoPage | null>(() => pages?.find(p => p.cid === cid) ?? null);
  const effPages = plItem ? undefined : pages;
  const effBvid = plItem?.bvid ?? activePage?.bvid ?? bvid;
  const [info, setInfo] = useState<ParsedVideoInfo | null>(videoInfo ?? null);
  const currentInfo = info?.bvid === effBvid ? info : null;
  const effAid = currentInfo?.aid ?? plItem?.aid ?? aid;
  const effTitle = plItem?.title ?? title;
  const currentCid = plItem?.cid ?? activePage?.cid ?? cid;
  const currentDuration = plItem?.duration || activePage?.duration || duration;
  const currentEpId = plItem?.epId ?? activePage?.ep_id ?? epId;
  const multiPage = !plItem && (effPages?.length ?? 0) > 1;
  const [qualities, setQualities] = useState<PlayQuality[]>([]);
  const [selectedQn, setSelectedQn] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [related, setRelated] = useState<VideoListItem[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [videoshot, setVideoshot] = useState<Videoshot | null>(null);

  useEffect(() => {
    let active = true;
    const initial = videoInfo?.bvid === effBvid ? videoInfo : null;
    setInfo(initial);
    if (!initial) invoke<ParsedVideoInfo>("parse_video", { urlStr: currentEpId ? `https://www.bilibili.com/bangumi/play/ep${currentEpId}` : `https://www.bilibili.com/video/${effBvid}` })
      .then(result => { if (active) setInfo(result); }).catch(() => {});
    setVideoshot(null);
    invoke<Videoshot>("get_videoshot", { bvid: effBvid, cid: currentCid })
      .then(result => { if (active && result.images.length) setVideoshot(result); }).catch(() => {});
    return () => { active = false; };
  }, [effBvid, currentCid, currentEpId, videoInfo]);

  useEffect(() => {
    if (!playlistOpen || sideTab !== "related") return;
    let active = true;
    setRelated([]); setRelatedLoading(true);
    invoke<VideoListItem[]>("get_related_videos", { bvid: effBvid })
      .then(result => { if (active) setRelated(result); }).catch(() => {})
      .finally(() => { if (active) setRelatedLoading(false); });
    return () => { active = false; };
  }, [effBvid, sideTab, playlistOpen]);

  const wakeControls = useCallback(() => {
    setControlsActive(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsActive(false), 2800);
  }, []);
  useEffect(() => { wakeControls(); }, [currentCid, wakeControls]);
  useEffect(() => () => clearTimeout(hideTimerRef.current), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
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
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null); // 所有全屏入口统一使用视频舞台，包含字幕/弹幕/控制栏
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
  const inSeekRef = useRef(false); // 切流期间沿用用户的播放意图，连续操作由最新一次请求接管

  const reportError = useCallback((msg: string) => {
    if (cancelledRef.current) return; // 已卸载 / StrictMode 重跑，不再报错
    invoke("log_player_error", { msg }).catch(() => {});
    setError(msg);
  }, []);

  const closeMenus = useCallback(() => {
    setMenuOpen(false);
    setCloseMenuSignal(value => value + 1);
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

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
        setNotice("当前环境不支持系统画中画，可使用应用内小窗"); return;
      }
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { setNotice("画中画暂不可用，请播放视频后重试"); }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen();
    } catch { setNotice("当前环境无法进入全屏"); }
  }, []);
  useEffect(() => {
    const sync = () => { setFullscreen(document.fullscreenElement === stageRef.current); wakeControls(); };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [wakeControls]);

  const toggleMini = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    closeMenus(); setMiniMode(value => !value); wakeControls();
  }, [closeMenus, wakeControls]);

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

  const pageIndex = effPages?.findIndex(page => page.cid === currentCid) ?? -1;
  const canNext = hasPlaylist ? playlistIdx < playlist!.length - 1 : multiPage && pageIndex >= 0 && pageIndex < effPages!.length - 1;
  const nextItem = useCallback(() => {
    if (!canNext) return;
    if (hasPlaylist) gotoPlaylistItem(playlistIdx + 1);
    else if (effPages) setActivePage(effPages[pageIndex + 1]);
  }, [canNext, hasPlaylist, gotoPlaylistItem, playlistIdx, effPages, pageIndex]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => { if (autoNext) nextItem(); };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [autoNext, nextItem]);

  // 索引可以迟到，但旧会话的响应绝不能覆盖新会话的索引。
  const loadSeekIndex = useCallback(async (videoUrl: string, audioUrl: string, signal: AbortSignal): Promise<SeekIndexResult | null> => {
    if (seekIndexRef.current?.videoUrl === videoUrl) {
      const cached = seekIndexRef.current;
      return { video: cached.video ?? null, audio: cached.audio ?? null };
    }
    return new Promise(resolve => {
      const finish = (result: SeekIndexResult | null) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(result);
      };
      const abort = () => finish(null);
      const timer = setTimeout(() => finish(null), 5000);
      if (signal.aborted) { finish(null); return; }
      signal.addEventListener("abort", abort, { once: true });
      invoke<SeekIndexResult>("get_seek_index", { videoUrl, audioUrl }).then(result => {
        if (!signal.aborted) seekIndexRef.current = { videoUrl, video: result.video ?? undefined, audio: result.audio ?? undefined };
        finish(result);
      }).catch(() => finish(null));
    });
  }, []);

  // 返回「已就绪」而非「已注册 sourceopen」，用于保护连续拖动、切画质的生命周期。
  const play = useCallback(async (quality: PlayQuality, resumeTime: number, shouldPlay = true) => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    const video = videoRef.current;
    if (!video || cancelledRef.current) return;
    inSeekRef.current = true;
    desiredPlayingRef.current = shouldPlay;
    currentQualityRef.current = quality;
    setLoading(true); setBuffering(false); setError(null);
    const videoMime = videoMimeFor(quality.codec);
    const audioMime = 'audio/mp4; codecs="mp4a.40.2"';
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(videoMime)) {
      reportError("当前 WebView 不支持此编码，请尝试其他画质");
      setLoading(false); inSeekRef.current = false; return;
    }
    const audio = { ...audioRef.current };
    const switching = resumeTime > 0.05;
    if (switching && freezeCanvasRef.current) freezeCanvasRef.current.style.display = "block";
    const index = switching ? await loadSeekIndex(quality.video_url, audio.url, ac.signal) : null;
    if (ac.signal.aborted) return;
    if (!switching) void loadSeekIndex(quality.video_url, audio.url, ac.signal);
    // 预留解码前滚：sidx 的分片边界可能早于 B 帧实际呈现时间，精确落在边界时取前一段。
    const decodeFrom = Math.max(0, resumeTime - .5);
    const vPoint = index?.video ? lookupPoint(index.video.points, decodeFrom) : null;
    const aPoint = index?.audio ? lookupPoint(index.audio.points, decodeFrom) : null;
    // 音频也必须有索引；否则两路都从头追帧，不能把远端视频与开头音频混接。
    const seek: SeekPlan | null = vPoint && index?.video && (!audio.has || (aPoint && index.audio)) ? {
      videoByte: vPoint.byte, initEndVideo: index.video.init_end,
      audioByte: aPoint?.byte ?? 0, initEndAudio: index.audio?.init_end ?? 0,
    } : null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const mediaSource = new MediaSource();
    objectUrlRef.current = URL.createObjectURL(mediaSource);
    video.autoplay = false;
    video.pause();
    video.src = objectUrlRef.current;
    video.defaultPlaybackRate = lastChosenRate;
    video.playbackRate = lastChosenRate;

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true; ac.signal.removeEventListener("abort", finish); resolve();
      };
      ac.signal.addEventListener("abort", finish, { once: true });
      const fail = (e: unknown) => {
        if (!ac.signal.aborted && acRef.current === ac) {
          reportError(`播放流加载失败：${e instanceof Error ? e.message : String(e)}`);
          setLoading(false); setBuffering(false); inSeekRef.current = false;
          ac.abort();
        }
        finish();
      };
      mediaSource.addEventListener("sourceopen", async () => {
        try {
          const vsb = mediaSource.addSourceBuffer(videoMime);
          const asb = audio.has && audio.url && MediaSource.isTypeSupported(audioMime) ? mediaSource.addSourceBuffer(audioMime) : null;
          if (audio.has && !asb) throw new Error("当前环境不支持音频编码");
          if (currentDuration > 0) mediaSource.duration = currentDuration;
          if (seek) {
            const init = await fetchRangeTotal(proxyUrl(quality.video_url), 0, seek.initEndVideo, ac.signal);
            await appendSafe(vsb, init.buf, video);
            if (asb && seek.initEndAudio > 0) {
              const audioInit = await fetchRangeTotal(proxyUrl(audio.url), 0, seek.initEndAudio, ac.signal);
              await appendSafe(asb, audioInit.buf, video);
            }
          }
          if (ac.signal.aborted) return;
          const tasks = [feedStream(proxyUrl(quality.video_url), vsb, video, ac.signal, resumeTime, seek?.videoByte ?? 0)];
          if (asb) tasks.push(feedStream(proxyUrl(audio.url), asb, video, ac.signal, resumeTime, seek?.audioByte ?? 0));
          // 立即挂失败处理，避免等待首帧期间产生未处理的 rejection。
          void Promise.all(tasks).then(() => {
            if (!ac.signal.aborted) safeEndOfStream(mediaSource, asb ? [vsb, asb] : [vsb]);
          }).catch(fail);
          await waitForBuffered(video, resumeTime, ac.signal);
          if (ac.signal.aborted || acRef.current !== ac) return;
          if (switching) video.currentTime = resumeTime;
          if (shouldPlay) {
            try { await video.play(); }
            catch { setNotice("点击播放按钮开始观看"); }
          } else video.pause();
          // 远端分片从非零时间开始时，要先定位才能产生首帧，不能在定位前等 readyState。
          await waitForBuffered(video, resumeTime, ac.signal, true);
          if (ac.signal.aborted) return;
          inSeekRef.current = false; setLoading(false); setBuffering(false);
          if (freezeCanvasRef.current) freezeCanvasRef.current.style.display = "none";
          finish();
        } catch (e) { fail(e); }
      }, { once: true, signal: ac.signal });
    });
  }, [currentDuration, loadSeekIndex, reportError]);

  useEffect(() => {
    let active = true;
    cancelledRef.current = false;
    setLoading(true); setError(null); setBuffering(false); setQualities([]);
    qualitiesRef.current = []; currentQualityRef.current = null; seekIndexRef.current = null;
    const restore = retryRef.current;
    retryRef.current = null;
    const resume = restore?.cid === currentCid && restore.bvid === effBvid ? restore : null;
    (async () => {
      try {
        const streams = await invoke<PlayStreams>("get_play_streams", {
          bvid: effBvid, cid: currentCid, epId: currentEpId ?? null, duration: currentDuration, codecs: PLAYER_CODECS,
        });
        if (!active) return;
        if (!streams.qualities.length) throw new Error("未取到视频流地址，请检查登录状态或稍后重试");
        qualitiesRef.current = streams.qualities;
        audioRef.current = { url: streams.audio_url, has: streams.has_audio };
        setQualities(streams.qualities);
        const q = streams.qualities.find(item => item.qn === lastChosenQn)
          ?? streams.qualities.find(item => item.qn === streams.default_qn) ?? streams.qualities[0];
        setSelectedQn(q.qn);
        await play(q, resume?.time ?? 0, resume?.playing ?? true);
      } catch (e) {
        if (active) { reportError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => {
      active = false; cancelledRef.current = true; acRef.current?.abort();
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
    };
  }, [effBvid, currentCid, currentEpId, currentDuration, play, reportError, reload]);

  const seekTo = useCallback((target: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(target)) return;
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : currentDuration;
    const time = Math.min(Math.max(0, target), Math.max(0, end - 0.15));
    if (isBuffered(video, time) && !inSeekRef.current) { video.currentTime = time; return; }
    const q = currentQualityRef.current;
    if (q) void play(q, time, inSeekRef.current ? desiredPlayingRef.current : !video.paused);
  }, [play, currentDuration]);

  const resumePlayback = useCallback(() => {
    if (resumeHint == null) return;
    seekTo(resumeHint); setResumeHint(null);
  }, [resumeHint, seekTo]);

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

  const switchPage = useCallback((page: VideoPage) => {
    closeMenus();
    if (page.cid === currentCid) return;
    if (freezeCanvasRef.current) {
      freezeCanvasRef.current.style.display = "none";
      freezeCanvasRef.current.getContext("2d")?.clearRect(0, 0, freezeCanvasRef.current.width, freezeCanvasRef.current.height);
    }
    setActivePage(page);
  }, [closeMenus, currentCid]);

  const switchQuality = useCallback((qn: number) => {
    const q = qualitiesRef.current.find(item => item.qn === qn);
    if (!q || q.qn === currentQualityRef.current?.qn) return;
    lastChosenQn = qn; setSelectedQn(qn); closeMenus();
    void play(q, videoRef.current?.currentTime ?? 0, inSeekRef.current ? desiredPlayingRef.current : !videoRef.current?.paused);
  }, [play, closeMenus]);

  const retry = useCallback(() => {
    retryRef.current = { bvid: effBvid, cid: currentCid, time: videoRef.current?.currentTime ?? 0, playing: desiredPlayingRef.current };
    setReload(value => value + 1);
  }, [effBvid, currentCid]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || loading || error) return;
    desiredPlayingRef.current = video.paused;
    if (video.paused) void video.play().catch(() => setNotice("暂时无法播放，请重试"));
    else video.pause();
    wakeControls();
  }, [loading, error, wakeControls]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const wait = () => setBuffering(true);
    const ready = () => setBuffering(false);
    const failure = () => { if (!cancelledRef.current && video.error) { setLoading(false); reportError(`视频解码失败（${video.error.code}），请尝试切换画质或重试`); } };
    video.addEventListener("waiting", wait); video.addEventListener("stalled", wait);
    video.addEventListener("playing", ready); video.addEventListener("canplay", ready); video.addEventListener("pause", ready);
    video.addEventListener("error", failure);
    return () => {
      video.removeEventListener("waiting", wait); video.removeEventListener("stalled", wait);
      video.removeEventListener("playing", ready); video.removeEventListener("canplay", ready); video.removeEventListener("pause", ready);
      video.removeEventListener("error", failure);
    };
  }, [reportError]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
      if (miniMode && !containerRef.current?.contains(target)) return;
      if (event.key === "Escape") {
        if (menuOpen) closeMenus();
        else if (document.fullscreenElement) void document.exitFullscreen();
        else if (playlistOpen) setPlaylistOpen(false);
        else if (theater) setTheater(false);
        else onBack();
        return;
      }
      // 菜单和普通按钮保留自己的空格/方向键语义。
      if (target?.closest("button, a, [role='tab']")) return;
      switch (event.key.toLowerCase()) {
        case " ": event.preventDefault(); togglePlay(); break;
        case "arrowleft": event.preventDefault(); seekTo(video.currentTime - 5); break;
        case "arrowright": event.preventDefault(); seekTo(video.currentTime + 5); break;
        case "arrowup": event.preventDefault(); video.volume = Math.min(1, video.volume + .1); break;
        case "arrowdown": event.preventDefault(); video.volume = Math.max(0, video.volume - .1); break;
        case "m": video.muted = !video.muted; break;
        case "d": toggleDanmaku(); break;
        case "f": event.preventDefault(); void toggleFullscreen(); break;
      }
      wakeControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [miniMode, menuOpen, playlistOpen, theater, closeMenus, onBack, togglePlay, seekTo, toggleDanmaku, toggleFullscreen, wakeControls]);

  const queue = hasPlaylist ? playlist! : (effPages ?? []);
  const lowerQuality = qualities.find(q => q.qn < (selectedQn ?? Infinity));
  const displayTitle = multiPage && activePage ? activePage.part : effTitle;
  const currentPage: VideoPage = { cid: currentCid, page: activePage?.page ?? 1, part: displayTitle, duration: currentDuration, bvid: effBvid, ep_id: currentEpId };
  const showSidebar = playlistOpen && !theater && !miniMode;

  return (
    <div ref={containerRef} className={`watch-page ${miniMode ? "watch-page--mini" : theater ? "watch-page--theater" : ""}`} tabIndex={-1} aria-label="视频播放页">
      <div className="watch-mini-header">
        <button type="button" aria-label="还原播放页" onClick={() => void toggleMini()}><Expand size={15} /></button>
        <strong>{displayTitle}</strong><button type="button" aria-label="关闭小窗" onClick={onBack}><X size={15} /></button>
      </div>
      <nav className="watch-nav" aria-label="播放页导航">
        <button type="button" className="watch-back" onClick={onBack}><ArrowLeft size={18} />返回</button>
        <span className="watch-nav-label">正在播放</span>
        <div className="watch-nav-actions">
          <button type="button" onClick={() => setTheater(value => !value)} aria-pressed={theater}><Minimize2 size={16} /><span>{theater ? "退出沉浸" : "沉浸模式"}</span></button>
          <button type="button" aria-label="切换选集侧栏" aria-expanded={showSidebar} onClick={() => { setTheater(false); setPlaylistOpen(value => !value); }}><PanelRight size={16} /><span>选集 / 推荐</span></button>
        </div>
      </nav>
      <div className={`watch-grid ${showSidebar ? "has-sidebar" : ""}`}>
        <main className="watch-main">
          <div ref={stageRef} className="watch-stage" tabIndex={0} aria-label="视频画面，空格播放暂停，F 全屏" onPointerMove={wakeControls} onPointerDown={wakeControls}
            onPointerLeave={() => setControlsActive(false)} onFocusCapture={wakeControls}>
            <video ref={videoRef} playsInline onClick={togglePlay} onDoubleClick={() => void toggleFullscreen()} />
            <canvas ref={freezeCanvasRef} className="object-contain" />
            <canvas ref={danmakuCanvasRef} />
            {activeCue && <div className="watch-subtitle"><span>{activeCue}</span></div>}
            {fullscreen && controlsActive && <button type="button" className="watch-fullscreen-back" onClick={() => void toggleFullscreen()}><ArrowLeft size={16} />退出全屏</button>}
            {resumeHint != null && !loading && !error && <div className="watch-resume"><button type="button" onClick={resumePlayback}><History size={14} />上次看到 {formatDuration(Math.floor(resumeHint))}，继续观看</button><button type="button" aria-label="关闭续播提示" onClick={() => setResumeHint(null)}><X size={13} /></button></div>}
            {(loading || buffering) && !error && <div className="watch-status" role="status"><Loader2 size={23} className="animate-spin" /><span>{loading ? "正在准备视频…" : "缓冲中…"}</span></div>}
            {notice && <div className="watch-notice" role="status">{notice}</div>}
            {error && <div className="watch-status watch-error" role="alert"><AlertCircle size={30} /><h2>暂时无法播放</h2><p>{error}</p><div className="watch-error-actions"><button type="button" onClick={retry}><RefreshCw size={15} />重新获取并重试</button>{lowerQuality && <button type="button" onClick={() => switchQuality(lowerQuality.qn)}>改用 {lowerQuality.label}</button>}</div></div>}
            <PlayerControls videoRef={videoRef} duration={currentDuration} active={controlsActive || loading} compact={miniMode && !fullscreen} fullscreen={fullscreen}
              closeMenuSignal={closeMenuSignal} qualities={qualities} selectedQn={selectedQn} rate={playbackRate} tracks={subTracks} selectedSubLan={selectedSubLan}
              danmakuOn={danmakuOn} danmakuCount={danmakuCount} canNext={canNext} onTogglePlay={togglePlay} onSeek={seekTo} onNext={nextItem}
              onQuality={switchQuality} onRate={applySpeed} onSubtitle={selectSubtitle} onDanmaku={toggleDanmaku} onFullscreen={() => void toggleFullscreen()}
              onPip={() => void togglePip()} onMini={() => void toggleMini()} onMenuChange={setMenuOpen}
              preview={ratio => {
                if (!videoshot) return null;
                const loc = locateShot(videoshot, ratio * currentDuration);
                if (!loc || !videoshot.images[loc[0]]) return null;
                const scale = 160 / videoshot.img_x_size;
                return <div style={{ width: 160, height: videoshot.img_y_size * scale, backgroundImage: `url(${proxyUrl(videoshot.images[loc[0]])})`, backgroundSize: `${videoshot.img_x_len * 160}px ${videoshot.img_y_len * videoshot.img_y_size * scale}px`, backgroundPosition: `-${loc[2] * 160}px -${loc[1] * videoshot.img_y_size * scale}px` }} />;
              }} />
          </div>
          <PlayerDetails key={`${effBvid}-${currentCid}`} info={currentInfo} title={displayTitle} page={currentPage} onSeek={seekTo} onDownload={onDownload} />
        </main>
        {showSidebar && <aside className="watch-sidebar" aria-label="选集与相关推荐">
          <div className="watch-side-tabs" role="tablist" aria-label="侧栏内容"><button type="button" role="tab" aria-selected={sideTab === "episodes"} onClick={() => setSideTab("episodes")}>选集</button><button type="button" role="tab" aria-selected={sideTab === "related"} onClick={() => setSideTab("related")}>相关推荐</button></div>
          {sideTab === "episodes" ? <>
            <div className="watch-list-head"><span>{queue.length > 1 ? `播放列表 · ${queue.length} 集` : "当前视频"}</span><button type="button" aria-pressed={autoNext} onClick={() => setAutoNext(value => !value)}><Repeat size={13} />连播{autoNext ? "开" : "关"}</button></div>
            <div className="watch-episodes">
              {queue.length > 0 ? queue.map((item, index) => {
                const selected = hasPlaylist ? index === playlistIdx : item.cid === currentCid;
                const itemTitle = "part" in item ? item.part : item.title;
                return <button type="button" className="watch-episode" key={`${item.cid}-${index}`} aria-current={selected ? "true" : undefined} onClick={() => hasPlaylist ? gotoPlaylistItem(index) : switchPage(item as VideoPage)}>
                  <span className="watch-episode-number">{selected ? <Play size={13} fill="currentColor" /> : String(index + 1).padStart(2, "0")}</span>
                  <span className="watch-episode-text"><span className="line-clamp-2">{itemTitle}</span><small>{formatDuration(item.duration)}{selected ? " · 正在播放" : ""}</small></span>
                </button>;
              }) : <div className="watch-list-empty">这是一个单集视频</div>}
            </div>
          </> : <div className="watch-episodes">
            {relatedLoading && <div className="watch-list-empty"><Loader2 size={18} className="animate-spin inline" /> 正在加载推荐</div>}
            {!relatedLoading && !related.length && <div className="watch-list-empty">暂无相关推荐</div>}
            {related.slice(0, 12).map(item => <button type="button" className="watch-episode" key={item.bvid} disabled={!onOpenRelated} onClick={() => onOpenRelated?.(item.bvid)}>
              <img src={item.cover} alt="" loading="lazy" /><span className="watch-episode-text"><span className="line-clamp-2">{item.title}</span><small>{item.upper_name}</small></span>
            </button>)}
          </div>}
        </aside>}
      </div>
    </div>
  );
}
