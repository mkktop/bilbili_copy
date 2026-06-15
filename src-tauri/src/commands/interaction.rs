use crate::bilibili::credential::Credential;
use crate::bilibili::interaction;

/// 点赞/取消点赞视频（需登录）
///
/// @param bvid 视频 bvid
/// @param like 1=点赞，2=取消点赞
#[tauri::command]
pub async fn like_video(bvid: String, like: Option<u8>) -> Result<(), String> {
    let credential = Credential::load().ok().flatten();
    let credential = credential.ok_or("未登录，请先登录后再操作")?;
    let like = like.unwrap_or(1);
    interaction::like_video(&credential, &bvid, like)
        .await
        .map_err(|e| e.to_string())
}

/// 投币视频（需登录）
///
/// @param bvid       视频 bvid
/// @param multiply   投币数量（1 或 2，默认 1）
/// @param selectLike 1=同时点赞，0=仅投币（默认 0）
#[tauri::command]
pub async fn coin_video(
    bvid: String,
    multiply: Option<u8>,
    select_like: Option<u8>,
) -> Result<(), String> {
    let credential = Credential::load().ok().flatten();
    let credential = credential.ok_or("未登录，请先登录后再操作")?;
    let multiply = multiply.unwrap_or(1);
    let select_like = select_like.unwrap_or(0);
    interaction::coin_video(&credential, &bvid, multiply, select_like)
        .await
        .map_err(|e| e.to_string())
}

/// 收藏视频到指定收藏夹（需登录）
///
/// @param aid      视频 aid
/// @param folderId 目标收藏夹 id（来自 get_favorite_folders）
#[tauri::command]
pub async fn favorite_video(aid: i64, folder_id: i64) -> Result<(), String> {
    let credential = Credential::load().ok().flatten();
    let credential = credential.ok_or("未登录，请先登录后再操作")?;
    interaction::favorite_video(&credential, aid, folder_id)
        .await
        .map_err(|e| e.to_string())
}
