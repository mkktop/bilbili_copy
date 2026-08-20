use crate::bilibili::credential::Credential;
use crate::bilibili::history::{self, HistoryCursor, HistoryResult};

/// 获取当前登录用户的观看历史（cursor 分页）
///
/// @param cursor 上一页返回的原始游标（首页传 None，翻页原样回传）
#[tauri::command]
pub async fn get_watch_history(
    cursor: Option<HistoryCursor>,
) -> Result<HistoryResult, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    history::get_watch_history(cursor, &credential)
        .await
        .map_err(|e| e.to_string())
}
