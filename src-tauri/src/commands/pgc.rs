use crate::bilibili::credential::Credential;
use crate::bilibili::pgc::{self, PgcRankItem};

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
