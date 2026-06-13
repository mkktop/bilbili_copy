use crate::bilibili::credential::Credential;
use crate::bilibili::submission::{self, UpperInfo};
use crate::bilibili::{PagedResult, VideoListItem};

/// 获取 UP 主卡片信息（头像/名字/签名/粉丝数/投稿数）
#[tauri::command]
pub async fn get_upper_info(mid: i64) -> Result<UpperInfo, String> {
    let credential = Credential::load().ok().flatten();
    submission::get_upper_info(mid, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取 UP 主投稿视频列表（按发布时间倒序，支持关键词过滤）
#[tauri::command]
pub async fn get_submission_videos(
    mid: i64,
    page: Option<u32>,
    keyword: Option<String>,
) -> Result<PagedResult<VideoListItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;
    let page = page.unwrap_or(1);

    submission::get_submission_videos(mid, page, keyword.as_deref(), &credential)
        .await
        .map_err(|e| e.to_string())
}
