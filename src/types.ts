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

/** 在线播放会话参数：VideoDetail「在线播放」→ App playingItem → VideoPlayer 的共享载荷。
 *  aid 为字幕列表 API 必填（player v2），随播放会话一起穿线。 */
export interface PlayingItem {
  bvid: string;
  aid: number;
  cid: number;
  epId?: number;
  duration: number;
  title: string;
  /** 正片分P列表：多分P时播放器顶栏显示「选集」菜单 */
  pages?: VideoPage[];
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
  /** UP 主名（文件名模板 {up}；恢复/重试时回传后端重建输出路径） */
  ownerName?: string;
  duration?: number;
  /** 下载完成后的文件绝对路径（done 状态才有；用于「打开所在目录」） */
  outputPath?: string;
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
  /** 最终文件字节数（v4 schema 新增，旧记录/未完成为 null） */
  size?: number | null;
  /** 视频时长（秒，v4 schema 新增，旧记录/未知为 null） */
  duration?: number | null;
  /** UP 主名（v6 schema 新增，旧记录为 null）：文件名模板 {up} 用 */
  owner_name?: string | null;
}

/** 下载统计聚合（对应后端 DownloadStats，仅 done 项累加大小/时长） */
export interface DownloadStats {
  /** 全部下载记录数 */
  total_count: number;
  /** 已完成（status='done'）的记录数 */
  done_count: number;
  /** 已完成记录的总字节数 */
  done_size: number;
  /** 已完成记录的总时长（秒） */
  done_duration: number;
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
    ownerName: entry.owner_name ?? undefined,
    outputPath: entry.output_path ?? undefined,
    duration: entry.duration ?? undefined,
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

/** 推荐视频条目（首页推荐流 data.item，需登录才有个性化） */
export interface RecommendItem {
  bvid: string;
  title: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  duration: number;
  play: number;
  danmaku: number;
  /** 发布时间（unix 秒），0 表示未知 */
  pubdate: number;
  like: number;
  /** 推荐理由（如「关注」「赞过」），可能为空 */
  rcmd_reason: string;
}

/** 分区视频条目（dynamic/region 最新视频流，公开接口） */
export interface RegionItem {
  bvid: string;
  title: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  duration: number;
  play: number;
  danmaku: number;
  /** 发布时间（unix 秒），0 表示未知 */
  pubdate: number;
  like: number;
}

/** 关注动态视频条目（web-dynamic feed/all type=video，需登录） */
export interface DynamicItem {
  bvid: string;
  title: string;
  cover: string;
  upper_name: string;
  upper_mid: number;
  upper_face: string;
  /** 发布时间（unix 秒） */
  pub_ts: number;
  /** 动态动作文案（如「投稿了视频」） */
  pub_action: string;
  /** 播放量展示文本（接口返回字符串，如「10.2万」） */
  play_text: string;
  /** 弹幕数展示文本 */
  danmaku_text: string;
  /** 时长展示文本（如「12:34」） */
  duration_text: string;
}

/** 动态流分页结果（cursor 分页：下一页把 offset 原样传回） */
export interface DynamicFeedResult {
  items: DynamicItem[];
  offset: string;
  has_more: boolean;
}

/** 视频评论条目（x/v2/reply，公开接口） */
export interface CommentItem {
  /** 评论 rpid（唯一 id） */
  rpid: number;
  /** 评论内容（纯文本） */
  content: string;
  /** 评论者用户名 */
  uname: string;
  /** 评论者头像 URL */
  avatar: string;
  /** 评论者 mid */
  mid: number;
  /** 评论者等级 */
  level: number;
  /** 点赞数 */
  like: number;
  /** 回复数（楼中楼） */
  reply_count: number;
  /** 发布时间（unix 秒） */
  ctime: number;
  /** 楼层 */
  floor: number;
}

/** PGC 排行榜条目（番剧/国创/电影等维度，非单视频） */
export interface PgcRankItem {
  /** 名次 1..100 */
  rank: number;
  /** 番剧季 ID（用于 season API 解析到单集） */
  season_id: number;
  title: string;
  cover: string;
  /** 综合得分（PGC 接口真实返回，UGC v2 没有） */
  score: number;
  /** 状态标签（如「全12话」「已完结」） */
  badge: string;
  desc: string;
  views: number;
  danmaku: number;
}

/** 追番/追剧条目（x/space/bangumi/follow/list，需登录） */
export interface BangumiFollowItem {
  /** 番剧季 ID（解析 ss{season_id} 进详情） */
  season_id: number;
  title: string;
  cover: string;
  /** 内容形态名（番剧/电影/纪录片…） */
  season_type_name: string;
  /** 状态角标（如「会员专享」） */
  badge: string;
  /** 更新状态文案（如「更新至第12话」「全26话」） */
  new_ep_show: string;
  /** 观看进度文案（如「看到第3话」，未看过为空） */
  progress: string;
  /** 评分（如 9.7；无评分为 0） */
  score: number;
  is_finish: boolean;
}

/** 追番/追剧分页结果 */
export interface BangumiFollowResult {
  items: BangumiFollowItem[];
  total: number;
  has_more: boolean;
  page: number;
}

/** 专栏文章数据（get_article_content 返回，content_html 需前端净化后渲染） */
export interface ArticleData {
  /** 传统专栏 cv 号（opus 图文时为 0） */
  cvid: number;
  /** opus 图文 id（字符串：19 位数超 JS 安全整数）；传统专栏为空串 */
  opus_id: string;
  title: string;
  author_name: string;
  author_mid: number;
  /** 发布时间（unix 秒） */
  publish_time: number;
  /** 字数（可能为 0） */
  words: number;
  banner_url: string;
  content_html: string;
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

