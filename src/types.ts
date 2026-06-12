export type DownloadStatus = "pending" | "parsing" | "downloading" | "done" | "error";

// ==================== 收藏夹类型 ====================

export interface FavoriteFolder {
  id: number;
  title: string;
  media_count: number;
}

export interface FavoriteMedia {
  id: number;
  title: string;
  bvid: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  duration: number | null;
  fav_time: number;
}

export interface FavoriteListResult {
  medias: FavoriteMedia[];
  total: number;
  has_more: boolean;
  page: number;
}

// ==================== 视频类型 ====================

export interface VideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
  bvid?: string;
  ep_id?: number;
}

export interface ParsedVideoInfo {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pic: string;
  owner_mid: number;
  owner_name: string;
  owner_face: string;
  duration: number;
  pages: VideoPage[];
  ep_id?: number;
  extra_pages?: VideoPage[];
  view_count?: number;
  danmaku_count?: number;
}

export interface DownloadEntry {
  id: string;
  url: string;
  title: string;
  status: DownloadStatus;
  progress?: number;
  errorMsg?: string;
  videoInfo?: ParsedVideoInfo;
}

/** 解析列表条目 */
export interface ParsedItem {
  id: string;
  url: string;
  title: string;
  status: "parsing" | "pending" | "error";
  errorMsg?: string;
  videoInfo?: ParsedVideoInfo;
}

/** 下载任务条目 */
export interface DownloadTask {
  id: string;
  title: string;
  status: "downloading" | "done" | "error";
  progress?: number;
  /** 当前下载阶段 */
  phase?: "video" | "audio" | "merging";
  errorMsg?: string;
}

/** 格式化秒数为 mm:ss 或 hh:mm:ss */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ==================== DB 类型 & 映射 ====================

/** DB 解析历史条目 */
export interface ParseHistoryEntry {
  id: string;
  url: string;
  bvid: string;
  title: string;
  video_info: ParsedVideoInfo;
  parsed_at: string;
}

/** DB 下载历史条目 */
export interface DownloadHistoryEntry {
  id: string;
  title: string;
  bvid: string;
  cid: number;
  ep_id: number | null;
  status: string;
  progress: number;
  phase: string | null;
  error_msg: string | null;
  output_path: string | null;
  created_at: string;
}

/** DB 解析历史 → 前端 ParsedItem */
export function dbToParsedItem(entry: ParseHistoryEntry): ParsedItem {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    status: "pending",
    videoInfo: entry.video_info,
  };
}

/** DB 下载历史 → 前端 DownloadTask */
export function dbToDownloadTask(entry: DownloadHistoryEntry): DownloadTask {
  return {
    id: entry.id,
    title: entry.title,
    status: entry.status as DownloadTask["status"],
    progress: entry.progress,
    phase: (entry.phase as DownloadTask["phase"]) ?? undefined,
    errorMsg: entry.error_msg ?? undefined,
  };
}
