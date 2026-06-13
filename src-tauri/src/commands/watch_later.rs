use crate::bilibili::credential::Credential;
use crate::bilibili::watch_later;
use crate::bilibili::VideoListItem;

/// 获取当前用户的稍后再看列表
#[tauri::command]
pub async fn get_watch_later() -> Result<Vec<VideoListItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    watch_later::get_watch_later(&credential)
        .await
        .map_err(|e| e.to_string())
}
