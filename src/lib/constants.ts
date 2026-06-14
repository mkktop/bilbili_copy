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
