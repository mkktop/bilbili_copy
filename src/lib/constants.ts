/**
 * 全局常量集中定义。
 *
 * 注意：历史记录分页大小 HISTORY_PAGE_SIZE 必须与 Rust 后端
 * `src-tauri/src/commands/history.rs` 中的 `PAGE_SIZE` 保持一致，
 * 改动时请同步两处（前后端无法共享常量值）。
 */

/** 解析历史 / 下载历史的每页条数（与后端 PAGE_SIZE 对齐） */
export const HISTORY_PAGE_SIZE = 20;

/** 下载进度落库节流间隔（ms）：每个任务至少间隔这么久才写一次 DB 进度 */
export const DOWNLOAD_PROGRESS_THROTTLE_MS = 1200;

/** toast 默认自动消失时长（ms） */
export const TOAST_DURATION_MS = 3500;

/**
 * 视频分区 tid 选项（精简版一级分区）。
 * 搜索高级筛选 / 排行榜筛选 共用此列表。
 * value 为字符串，与 B站接口 query 参数类型一致。
 *
 * 注意：番剧(13)/国创(167)是 PGC 内容，不参与 UGC 排行榜（rid=13 会返回 -400），
 * 故不在此列表中。搜索场景下这些 tid 也无意义（搜索走的是 media_bangumi 类型）。
 */
export const TID_OPTIONS = [
  { value: "0", label: "全站/全分区" },
  { value: "1", label: "动画" },
  { value: "3", label: "音乐" },
  { value: "4", label: "游戏" },
  { value: "5", label: "娱乐" },
  { value: "36", label: "科技" },
  { value: "188", label: "科普" },
  { value: "160", label: "生活" },
  { value: "211", label: "美食" },
  { value: "129", label: "舞蹈" },
  { value: "155", label: "时尚" },
  { value: "217", label: "动物" },
  { value: "223", label: "汽车" },
  { value: "234", label: "运动" },
  { value: "119", label: "鬼畜" },
  { value: "181", label: "影视" },
];

/**
 * PGC 排行榜分类（番剧/国创/电影/电视剧/纪录片/综艺）。
 * 注意 B站 PGC season_type 是离散枚举，6=不存在，1/2/3/4/5/7 是有效值。
 * 排序按用户使用频率：国创/番剧/电影 放前面。
 */
export const PGC_SEASON_TYPE_OPTIONS = [
  { value: "4", label: "国创" },
  { value: "1", label: "番剧" },
  { value: "2", label: "电影" },
  { value: "5", label: "电视剧" },
  { value: "3", label: "纪录片" },
  { value: "7", label: "综艺" },
];
