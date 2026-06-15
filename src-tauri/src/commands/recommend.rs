use crate::bilibili::credential::Credential;
use crate::bilibili::recommend::{self, RecommendItem};

/// 获取首页推荐视频流（个性化推荐，需登录）
///
/// @param fresh_idx 刷新索引，首次 1，每次"换一批"递增（默认 1）
#[tauri::command]
pub async fn get_recommend(
    fresh_idx: Option<u32>,
) -> Result<Vec<RecommendItem>, String> {
    let credential = Credential::load().ok().flatten();
    // 登录才可用：无凭证直接报错（前端会显示登录提示，后端兜底）
    let credential = credential.ok_or("未登录，请先登录后再使用推荐功能")?;
    let fresh_idx = fresh_idx.unwrap_or(1);

    recommend::get_recommend(fresh_idx, Some(&credential))
        .await
        .map_err(|e| e.to_string())
}
