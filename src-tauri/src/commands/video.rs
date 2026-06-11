use crate::bilibili::credential::Credential;
use crate::bilibili::url;
use crate::bilibili::video;
use crate::bilibili::video::VideoInfo;

/// 解析视频链接，返回视频详细信息
#[tauri::command]
pub async fn parse_video(url_str: String) -> Result<VideoInfo, String> {
    // 1. 解析 URL 提取 BV/AV 号
    let mut parsed = url::parse_bilibili_url(&url_str).map_err(|e| e.to_string())?;

    // 2. 如果是短链接，先解析重定向
    if let Some(short_url) = parsed.short_url.take() {
        parsed = url::resolve_short_url(&short_url)
            .await
            .map_err(|e| format!("短链接解析失败: {}", e))?;
    }

    // 3. 尝试加载凭证（可选，未登录也能解析基本信息）
    let credential = Credential::load().ok().flatten();

    // 4. 调用 view API 获取视频信息
    let info = video::get_video_info(
        parsed.bvid.as_deref(),
        parsed.aid,
        parsed.ep_id,
        credential.as_ref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(info)
}
