use crate::bilibili::comment::{self, CommentItem};
use crate::bilibili::{PagedResult, credential::Credential};

/// 获取视频评论（公开接口，无需登录）
///
/// @param aid 视频 aid（作为 oid）
/// @param pn  页码，从 1 开始（默认 1）
#[tauri::command]
pub async fn get_video_comments(
    aid: i64,
    pn: Option<u32>,
) -> Result<PagedResult<CommentItem>, String> {
    // 公开接口：登录态可选，已登录则带 cookie
    let credential = Credential::load().ok().flatten();
    let pn = pn.unwrap_or(1);

    comment::get_comments(aid, pn, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
