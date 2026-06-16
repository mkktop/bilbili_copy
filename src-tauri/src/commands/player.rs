//! 在线播放相关命令（独立于下载路径）。
//!
//! 在线播放强制 H.264/AVC + AAC：webview 的 MSE 对 avc1/mp4a 支持最完整。
//! 下载路径完全不受影响（仍走用户的 codec_priority 与画质设置）。

use tauri::command;

use crate::bilibili::credential::Credential;
use crate::bilibili::danmaku::{self, Danmu, DanmuType};
use crate::bilibili::{api_client, playurl};
use crate::commands::settings::load_settings;
use serde::Serialize;

/// 前端把播放器/拉流错误回传到 app.log（前端控制台错误默认不落盘，此命令用于诊断）
#[command]
pub fn log_player_error(msg: String) {
    log::warn!("[player] {}", msg);
}

/// 在线播放流地址
#[derive(Serialize)]
pub struct PlayStreams {
    /// 视频流主 URL（前端经 biliproxy 代理拉取字节喂给 MSE）
    pub video_url: String,
    /// 音频流主 URL（可能为空，如 legacy 合并流）
    pub audio_url: String,
    pub has_audio: bool,
    /// 命中的画质 id
    pub video_qn: i64,
    /// 视频时长（秒，前端用于弹幕分段与 UI）
    pub duration: u64,
}

/// 获取在线播放流（强制 AVC/H.264，画质封顶 1080P）。
/// 前端拿到 video_url / audio_url 后，经 biliproxy 代理用 MSE 边下边播。
#[command]
pub async fn get_play_streams(
    bvid: String,
    cid: i64,
    ep_id: Option<u64>,
    duration: u64,
) -> Result<PlayStreams, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {e}"))?
        .ok_or_else(|| "未登录，请先登录".to_string())?;
    let settings = load_settings();
    // 在线播放强制 AVC：webview/MSE 对 H.264(avc1)+AAC 支持最完整
    let codec_priority: Vec<String> = vec!["AVC".to_string()];
    let streams = playurl::get_playurl(
        &bvid,
        cid,
        &credential,
        80,  // video_max_qn：在线播放封顶 1080P（兼顾质量与流量）
        16,  // video_min_qn：下限 360P
        30280, // audio_max_qn：取较高质量音频
        0,     // audio_min_qn
        &codec_priority,
        ep_id,
        &settings.dm_img_str,
        &settings.dm_cover_img_str,
        &settings.dm_img_list,
        &settings.dm_img_inter,
        0, // request_delay_ms：在线播放无需逐档降级延迟
    )
    .await
    .map_err(|e| format!("获取播放流失败: {e}"))?;

    Ok(PlayStreams {
        video_url: streams.video_urls.first().cloned().unwrap_or_default(),
        audio_url: streams.audio_urls.first().cloned().unwrap_or_default(),
        has_audio: streams.has_audio(),
        video_qn: streams.video_qn,
        duration,
    })
}

/// 在线播放弹幕条目（供前端弹幕覆盖层渲染，非 ASS 文件）
#[derive(Serialize)]
pub struct DanmakuItem {
    /// 出现时间（秒）
    pub time: f64,
    pub text: String,
    /// 1=滚动 4=底部 5=顶部 6=逆向
    pub mode: u8,
    /// hex 颜色 "#rrggbb"
    pub color: String,
}

/// 获取视频弹幕列表（原始 JSON，供播放器弹幕层渲染）
#[command]
pub async fn get_danmaku_json(cid: i64, aid: u64, duration: u64) -> Result<Vec<DanmakuItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {e}"))?
        .ok_or_else(|| "未登录，请先登录".to_string())?;
    let client = api_client();
    let list = danmaku::fetch_danmaku_list(&client, &credential, cid, aid, duration)
        .await
        .map_err(|e| format!("获取弹幕失败: {e}"))?;
    Ok(list.into_iter().map(danmu_to_item).collect())
}

/// Danmu → 前端弹幕条目
fn danmu_to_item(d: Danmu) -> DanmakuItem {
    DanmakuItem {
        time: d.timeline_s,
        text: d.content,
        mode: match d.r#type {
            DanmuType::Float => 1,
            DanmuType::Bottom => 4,
            DanmuType::Top => 5,
            DanmuType::Reverse => 6,
        },
        color: format!("#{:02x}{:02x}{:02x}", d.rgb.0, d.rgb.1, d.rgb.2),
    }
}
