use crate::bilibili::credential::Credential;
use crate::bilibili::ranking::{self, RankingItem};

/// 获取排行榜视频列表（公开接口，无需登录）
///
/// @param rid  分区 id，0 = 全站（默认 0）
#[tauri::command]
pub async fn get_ranking(rid: Option<u32>) -> Result<Vec<RankingItem>, String> {
    // 公开接口：登录态可选，已登录则带 cookie
    let credential = Credential::load().ok().flatten();
    let rid = rid.unwrap_or(0);

    ranking::get_ranking(rid, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
