use crate::bilibili::credential::Credential;
use crate::bilibili::region::{self, RegionItem};

/// 获取分区最新视频列表（公开接口，无需登录）
///
/// @param rid  分区 id（默认 1=动画；全部分区见前端 TID_OPTIONS）
/// @param ps   每页数量（默认 30）
#[tauri::command]
pub async fn get_region(
    rid: Option<u32>,
    ps: Option<u32>,
) -> Result<Vec<RegionItem>, String> {
    // 公开接口：登录态可选，已登录则带 cookie
    let credential = Credential::load().ok().flatten();
    let rid = rid.unwrap_or(1);
    let ps = ps.unwrap_or(30);

    region::get_region(rid, ps, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
