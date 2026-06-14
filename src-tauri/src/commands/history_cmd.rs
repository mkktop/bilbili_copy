use crate::bilibili::credential::Credential;
use crate::bilibili::history::{self, HistoryItem};
use crate::bilibili::PagedResult;

/// 获取当前登录用户的观看历史（cursor 分页）
///
/// @param max_view_at 上一页最后一条的 view_at（首页传 None）
#[tauri::command]
pub async fn get_watch_history(
    max_view_at: Option<i64>,
) -> Result<PagedResult<HistoryItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    history::get_watch_history(max_view_at, &credential)
        .await
        .map_err(|e| e.to_string())
}
