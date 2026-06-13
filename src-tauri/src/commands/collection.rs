use crate::bilibili::collection::{self, CollectionInfo, SubscribedCollection};
use crate::bilibili::credential::Credential;
use crate::bilibili::{PagedResult, VideoListItem};

/// 获取 UP 主的合集与列表（UGC season/series）
#[tauri::command]
pub async fn get_upper_collections(mid: i64) -> Result<Vec<CollectionInfo>, String> {
    let credential = Credential::load().ok().flatten();
    collection::get_upper_collections(mid, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取合集/列表内的视频
/// collection_type: "season"（合集）或 "series"（列表）
#[tauri::command]
pub async fn get_collection_videos(
    mid: i64,
    sid: String,
    collection_type: String,
    page: Option<u32>,
) -> Result<PagedResult<VideoListItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;
    let page = page.unwrap_or(1);

    collection::get_collection_videos(mid, &sid, &collection_type, page, &credential)
        .await
        .map_err(|e| e.to_string())
}

/// 获取当前用户订阅的合集与收藏夹
#[tauri::command]
pub async fn get_subscribed_collections() -> Result<Vec<SubscribedCollection>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    collection::get_subscribed_collections(&credential)
        .await
        .map_err(|e| e.to_string())
}
