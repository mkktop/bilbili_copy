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
  play: number;
  like: number;
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
  series_title?: string;
  /** 发布时间戳（Unix 秒），0 表示未知 */
  pubdate?: number;
  /** 点赞数 */
  like_count?: number;
  /** 标签（普通视频来自 tag API，番剧来自 season API 的 styles） */
  tags?: string[];
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
  /** queued=排队中, downloading=下载中, paused=已暂停, done=完成, error=失败 */
  status: "queued" | "downloading" | "paused" | "done" | "error";
  progress?: number;
  /** 当前下载阶段 */
  phase?: "video" | "audio" | "merging";
  errorMsg?: string;
  /** 视频封面 URL */
  pic?: string;
  // 以下字段用于「恢复/重试」下载时重新提交（pause→resume / error→retry）。
  // 历史记录加载时从 DB 填充；运行时新提交的任务由 handleDownload 填充。
  bvid?: string;
  cid?: number;
  epId?: number | null;
  /** 画质（用于跨会话续传指纹匹配；恢复时作为 qn 传入） */
  quality?: number | null;
  /** 合集名（恢复时作为 video_title 传入以重建下载目录） */
  videoTitle?: string;
  duration?: number;
}

/**
 * NFO 元数据快照：从 ParsedVideoInfo 提取，下载完成时透传给后端生成 .nfo + 封面图。
 * 字段与 Rust 的 `VideoMeta` 一一对应（serde 自动序列化为 snake_case）。
 */
export interface VideoMeta {
  bvid: string;
  title: string;
  desc: string;
  pic: string;
  owner_mid: number;
  owner_name: string;
  owner_face: string;
  duration: number;
  pubdate: number;
  view_count: number;
  like_count: number;
  danmaku_count: number;
  tags: string[];
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
  /** 视频封面 URL（v2 schema 新增，旧记录为 null） */
  pic: string | null;
  created_at: string;
  /** 画质（v3 schema 新增，旧记录为 null） */
  quality?: number | null;
  /** 合集名（v3 schema 新增，旧记录为 null） */
  video_title?: string | null;
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
    pic: entry.pic ?? undefined,
    // 恢复/重试所需的原始下载参数
    bvid: entry.bvid,
    cid: entry.cid,
    epId: entry.ep_id,
    quality: entry.quality ?? null,
    videoTitle: entry.video_title ?? undefined,
  };
}

// ==================== 通用列表类型 ====================

/** 通用视频列表项：稍后再看 / 投稿 / 合集 共用 */
export interface VideoListItem {
  bvid: string;
  title: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  duration: number;
  play: number;
  danmaku: number;
  pubdate: number;
}

/** 观看历史条目：通用视频字段 + 观看时间 + 已观看秒数 */
export interface HistoryItem extends VideoListItem {
  /** 观看时间（unix 秒），cursor 分页用 */
  view_at: number;
  /** 已观看秒数 */
  progress: number;
}

/** 排行榜条目：通用视频字段 + 名次 + 综合分 + 点赞 */
export interface RankingItem {
  /** 名次 1..100 */
  rank: number;
  bvid: string;
  title: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  duration: number;
  play: number;
  danmaku: number;
  pubdate: number;
  /** 综合得分（B站排行计算用） */
  score: number;
  like: number;
}

/** 通用分页结果 */
export interface PagedResult<T> {
  items: T[];
  total: number;
  has_more: boolean;
  page: number;
}

/** unix 秒 → 本地日期字符串 */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ==================== 搜索类型 ====================

export type SearchResultType = "video" | "bili_user" | "media_bangumi" | "media_ft";

export interface SearchResult {
  type: SearchResultType;
  title: string;
  author: string;
  bvid?: string;
  aid?: number;
  mid?: number;
  season_id?: string;
  media_id?: string;
  cover: string;
  description: string;
  duration?: string;
  pubdate?: number;
  play?: number;
  danmaku?: number;
  follower?: number;
}

export interface SearchResultList {
  results: SearchResult[];
  total: number;
  num_pages: number;
  page: number;
}

// ==================== UP 主 / 合集类型 ====================

/** UP 主卡片信息 */
export interface UpperInfo {
  mid: number;
  name: string;
  face: string;
  sign: string;
  level: number;
  fans: number;
  following: number;
  archive_count: number;
}

/** UP 主的合集/列表 */
export interface CollectionInfo {
  id: string;
  name: string;
  cover: string;
  description: string;
  total: number;
  collection_type: "season" | "series";
  mid: number;
}

/** 用户订阅的合集/收藏夹 */
export interface SubscribedCollection {
  id: string;
  name: string;
  cover: string;
  description: string;
  total: number;
  collection_type: "favorite" | "season";
  upper_name: string;
  upper_mid: number;
}

/** 关注的 UP 主 */
export interface FollowingItem {
  mid: number;
  name: string;
  face: string;
  sign: string;
}

