use crate::bilibili::credential::Credential;
use crate::bilibili::pgc::{self, BangumiFollowResult, PgcRankItem};

/// 获取 PGC 排行榜（番剧/国创/电影/电视剧/纪录片/综艺）
///
/// @param season_type 1=番剧 2=电影 3=纪录片 4=国创 5=电视剧 7=综艺（默认 4=国创）
#[tauri::command]
pub async fn get_pgc_rank(season_type: Option<u8>) -> Result<Vec<PgcRankItem>, String> {
    // 公开接口：登录态可选，已登录则带 cookie
    let credential = Credential::load().ok().flatten();
    let season_type = season_type.unwrap_or(4);

    pgc::get_pgc_rank(season_type, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取追番/追剧列表（需登录）
///
/// @param follow_type 1=追番 2=追剧（默认 1）
/// @param page 页码（默认 1）
#[tauri::command]
pub async fn get_bangumi_follow(
    follow_type: Option<u8>,
    page: Option<u32>,
) -> Result<BangumiFollowResult, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {e}"))?
        .ok_or("未登录，请先登录后再查看追番列表")?;

    pgc::get_bangumi_follow(
        follow_type.unwrap_or(1),
        page.unwrap_or(1).max(1),
        &credential,
    )
    .await
    .map_err(|e| e.to_string())
}
