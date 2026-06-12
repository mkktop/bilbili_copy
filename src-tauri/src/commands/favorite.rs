use crate::bilibili::credential::Credential;
use crate::bilibili::favorite::{self, FavoriteFolder, FavoriteListResult};

/// 获取当前用户创建的收藏夹列表
#[tauri::command]
pub async fn get_favorite_folders() -> Result<Vec<FavoriteFolder>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    favorite::get_user_favorite_folders(&credential)
        .await
        .map_err(|e| e.to_string())
}

/// 分页获取收藏夹内的视频列表
#[tauri::command]
pub async fn get_favorite_videos(
    media_id: String,
    page: Option<u32>,
) -> Result<FavoriteListResult, String> {
    let credential = Credential::load().ok().flatten();
    let page = page.unwrap_or(1);

    favorite::get_favorite_videos(&media_id, page, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
