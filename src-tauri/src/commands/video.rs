use crate::bilibili::credential::Credential;
use crate::bilibili::url;
use crate::bilibili::video;
use crate::bilibili::video::VideoInfo;

/// 解析视频链接，返回视频详细信息
#[tauri::command]
pub async fn parse_video(url_str: String) -> Result<VideoInfo, String> {
    // 1. 解析 URL 提取 BV/AV 号
    let parsed = url::parse_bilibili_url(&url_str).map_err(|e| e.to_string())?;

    // 2. 尝试加载凭证（可选，未登录也能解析基本信息）
    let credential = Credential::load().ok().flatten();

    // 3. 调用 view API 获取视频信息
    let info = video::get_video_info(
        parsed.bvid.as_deref(),
        parsed.aid,
        credential.as_ref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(info)
}
