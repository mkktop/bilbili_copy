use crate::bilibili::credential::Credential;
use crate::bilibili::search::{self, SearchResultList};

/// 搜索 B站内容
/// search_type: video(视频) / bili_user(UP主) / media_bangumi(番剧) / media_ft(影视)
#[tauri::command]
pub async fn search_videos(
    keyword: String,
    search_type: Option<String>,
    page: Option<u32>,
) -> Result<SearchResultList, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    let search_type = search_type.unwrap_or_else(|| "video".to_string());
    let page = page.unwrap_or(1);

    search::search(&keyword, &search_type, page, &credential)
        .await
        .map_err(|e| e.to_string())
}
