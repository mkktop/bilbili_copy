use tauri::State;

use crate::db::{
    self, DownloadHistoryEntry, DownloadStats, ParseHistoryEntry,
};

const PAGE_SIZE: u32 = 20;

/// 获取解析历史（分页）
#[tauri::command]
pub fn get_parse_history(
    db: State<'_, db::DbState>,
    page: Option<u32>,
) -> Result<Vec<ParseHistoryEntry>, String> {
    let page = page.unwrap_or(1).max(1);
    let offset = (page - 1) * PAGE_SIZE;
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::get_all_parses(&conn, PAGE_SIZE, offset).map_err(|e| format!("查询解析历史失败: {}", e))
}

/// 获取解析历史总数
#[tauri::command]
pub fn get_parse_count(db: State<'_, db::DbState>) -> Result<u32, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::count_parses(&conn).map_err(|e| format!("查询解析总数失败: {}", e))
}

/// 保存解析记录（解析成功后调用）
#[tauri::command]
pub fn save_parse_history(
    db: State<'_, db::DbState>,
    entry: ParseHistoryEntry,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::insert_parse(&conn, &entry).map_err(|e| format!("保存解析记录失败: {}", e))
}

/// 删除单条解析记录
#[tauri::command]
pub fn delete_parse_history(
    db: State<'_, db::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::delete_parse(&conn, &id).map_err(|e| format!("删除解析记录失败: {}", e))
}

/// 更新解析记录时间戳（置顶）
#[tauri::command]
pub fn touch_parse_history(
    db: State<'_, db::DbState>,
    bvid: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::touch_parse(&conn, &bvid).map_err(|e| format!("更新解析时间失败: {}", e))
}

/// 清空所有解析历史
#[tauri::command]
pub fn clear_parse_history(db: State<'_, db::DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::clear_all_parses(&conn).map_err(|e| format!("清空解析历史失败: {}", e))
}

/// 获取下载历史（分页）
#[tauri::command]
pub fn get_download_history(
    db: State<'_, db::DbState>,
    page: Option<u32>,
) -> Result<Vec<DownloadHistoryEntry>, String> {
    let page = page.unwrap_or(1).max(1);
    let offset = (page - 1) * PAGE_SIZE;
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::get_all_downloads(&conn, PAGE_SIZE, offset).map_err(|e| format!("查询下载历史失败: {}", e))
}

/// 获取下载历史总数
#[tauri::command]
pub fn get_download_count(db: State<'_, db::DbState>) -> Result<u32, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::count_downloads(&conn).map_err(|e| format!("查询下载总数失败: {}", e))
}

/// 获取下载统计（累计视频数 / 总大小 / 总时长，仅累加已完成项）
#[tauri::command]
pub fn get_download_stats(db: State<'_, db::DbState>) -> Result<DownloadStats, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::download_stats(&conn).map_err(|e| format!("查询下载统计失败: {}", e))
}

/// 新增下载记录（开始下载时调用）
#[tauri::command]
pub fn save_download_entry(
    db: State<'_, db::DbState>,
    entry: DownloadHistoryEntry,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::insert_download(&conn, &entry).map_err(|e| format!("保存下载记录失败: {}", e))
}

/// 更新下载状态（进度/完成/失败时调用）
#[tauri::command]
pub fn update_download_status(
    db: State<'_, db::DbState>,
    id: String,
    status: String,
    progress: Option<f64>,
    phase: Option<String>,
    error_msg: Option<String>,
    output_path: Option<String>,
    size: Option<u64>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    // u64 → i64 以适配 SQLite 的 INTEGER（实际文件大小远小于 i64 上限，转换安全）
    let size_i64 = size.map(|s| s as i64);

    // 完成态迁移判定：当前状态非 done、新状态为 done → 累加统计一次。
    // 这样重试/重复完成同一 id 不会重复计数，暂停→恢复→完成也只计一次。
    if status == "done" {
        let prev = db::get_download_row_status(&conn, &id)
            .map_err(|e| format!("查询下载记录失败: {}", e))?;
        // 仅当记录存在且原状态不是 done 时累加
        if let Some((prev_status, _prev_size, prev_duration)) = prev {
            if prev_status != "done" {
                // size 取本次参数（最终文件大小），duration 取已落库的列值（提交时写入）
                let sz = size.unwrap_or(0);
                let dur = prev_duration.map(|d| d.max(0) as u64).unwrap_or(0);
                db::increment_download_stats(&conn, sz, dur)
                    .map_err(|e| format!("更新下载统计失败: {}", e))?;
            }
        }
    }

    db::update_download(
        &conn,
        &id,
        &status,
        progress,
        phase.as_deref(),
        error_msg.as_deref(),
        output_path.as_deref(),
        size_i64,
    )
    .map_err(|e| format!("更新下载状态失败: {}", e))
}

/// 删除单条下载记录
#[tauri::command]
pub fn delete_download_history(
    db: State<'_, db::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::delete_download(&conn, &id).map_err(|e| format!("删除下载记录失败: {}", e))
}

/// 清空所有下载历史
#[tauri::command]
pub fn clear_download_history(db: State<'_, db::DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::clear_all_downloads(&conn).map_err(|e| format!("清空下载历史失败: {}", e))
}

/// 读取在线播放进度（秒），无记录返回 null
#[tauri::command]
pub fn get_play_progress(db: State<'_, db::DbState>, cid: i64) -> Result<Option<f64>, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::get_play_progress(&conn, cid).map_err(|e| format!("读取播放进度失败: {}", e))
}

/// 保存在线播放进度。接近结尾（剩余 <15s 或 ≥95%）视为看完 → 删除记录，下次从头播。
#[tauri::command]
pub fn save_play_progress(
    db: State<'_, db::DbState>,
    cid: i64,
    bvid: String,
    position: f64,
    duration: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let dur = duration as f64;
    let finished = dur > 0.0 && (dur - position < 15.0 || position / dur >= 0.95);
    if finished {
        db::delete_play_progress(&conn, cid).map_err(|e| format!("清除播放进度失败: {}", e))
    } else {
        db::upsert_play_progress(&conn, cid, &bvid, position, duration)
            .map_err(|e| format!("保存播放进度失败: {}", e))
    }
}
