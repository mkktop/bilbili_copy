use crate::bilibili::comment::{self, CommentItem};
use crate::bilibili::{PagedResult, credential::Credential};

/// 获取视频评论（公开接口，无需登录）
///
/// @param aid 视频 aid（作为 oid）
/// @param pn  页码，从 1 开始（默认 1）
/// @param mode 排序：3=按热度（默认），2=按时间
#[tauri::command]
pub async fn get_video_comments(
    aid: i64,
    pn: Option<u32>,
    mode: Option<u32>,
) -> Result<PagedResult<CommentItem>, String> {
    // 公开接口：登录态可选，已登录则带 cookie
    let credential = Credential::load().ok().flatten();
    let pn = pn.unwrap_or(1);
    let mode = mode.unwrap_or(3);

    comment::get_comments(aid, pn, mode, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取楼中楼回复（某条评论下的子回复，分页）
///
/// @param aid  视频 aid（作为 oid）
/// @param root 根评论 rpid
/// @param pn   页码，从 1 开始（默认 1）
#[tauri::command]
pub async fn get_comment_replies(
    aid: i64,
    root: i64,
    pn: Option<u32>,
) -> Result<PagedResult<CommentItem>, String> {
    let credential = Credential::load().ok().flatten();
    let pn = pn.unwrap_or(1);

    comment::get_replies(aid, root, pn, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
