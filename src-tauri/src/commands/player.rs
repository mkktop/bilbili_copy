//! 在线播放相关命令（独立于下载路径）。
//!
//! 在线播放强制 H.264/AVC + AAC：webview 的 MSE 对 avc1/mp4a 支持最完整。
//! 下载路径完全不受影响（仍走用户的 codec_priority 与画质设置）。

use tauri::command;

use crate::bilibili::credential::Credential;
use crate::bilibili::danmaku::{self, Danmu, DanmuType};
use crate::bilibili::mp4_seek;
use crate::bilibili::subtitle::{self, SubtitleCue};
use crate::bilibili::{api_client, playurl};
use crate::commands::settings::load_settings;
use serde::Serialize;

/// 前端把播放器/拉流错误回传到 app.log（前端控制台错误默认不落盘，此命令用于诊断）
#[command]
pub fn log_player_error(msg: String) {
    log::warn!("[player] {}", msg);
}

/// 在线播放可选画质
#[derive(Serialize)]
pub struct PlayQuality {
    /// 画质 id（16/32/64/80/112/116/120/125/126/127…）
    pub qn: i64,
    /// 中文画质名（如 "1080P"）
    pub label: String,
    /// 编码名（AVC-only 下恒为 "AVC"）
    pub codec: String,
    /// 该画质视频流主 URL（前端经 biliproxy 代理拉取喂给 MSE）
    pub video_url: String,
}

/// 在线播放流地址
#[derive(Serialize)]
pub struct PlayStreams {
    /// 所有可选画质（按 qn 降序，仅含命中的编码）
    pub qualities: Vec<PlayQuality>,
    /// 音频流主 URL（各画质共享，可能为空如 legacy 合并流）
    pub audio_url: String,
    pub has_audio: bool,
    /// 默认画质 id（qualities[0].qn，即最高画质）
    pub default_qn: i64,
    /// 视频时长（秒，前端用于弹幕分段与 UI）
    pub duration: u64,
}

/// qn → 中文画质名
fn qn_label(qn: i64) -> &'static str {
    match qn {
        127 => "8K 超高清",
        126 => "杜比视界",
        125 => "HDR 真彩",
        120 => "4K 超清",
        116 => "1080P60",
        112 => "1080P高码率",
        80 => "1080P",
        64 => "720P",
        32 => "480P",
        16 => "360P",
        _ => "未知画质",
    }
}

/// codecid → 编码名（展示层完整名，7=AVC,12=HEVC,13=AV1）。
/// 仅用于 UI 显示；编码「匹配」逻辑唯一权威是 bilibili::playurl::codec_name
/// （"HEV" 短名，与 B站 settings 一致）。两处命名刻意不同，勿"顺手统一"——
/// 匹配侧若改成 "HEVC" 会让 HEVC 流永远选不中。
fn codec_label(codecid: i64) -> &'static str {
    match codecid {
        7 => "AVC",
        12 => "HEVC",
        13 => "AV1",
        _ => "?",
    }
}

/// 获取在线播放流（强制 AVC/H.264；画质取消 1080P 上限，返回全部可选 AVC 画质）。
/// 前端拿到 qualities / audio_url 后，经 biliproxy 代理用 MSE 边下边播，并提供画质切换。
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
        127,  // video_max_qn：取消 1080P 上限，4K/8K 若 B站 提供 AVC 则入列
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

    let audio_url = streams.audio_urls.first().cloned().unwrap_or_default();
    let has_audio = streams.has_audio();

    // 收集全部可选 AVC 画质（降序）
    let mut qualities: Vec<PlayQuality> = streams
        .all_qualities
        .iter()
        .map(|q| PlayQuality {
            qn: q.qn,
            label: qn_label(q.qn).to_string(),
            codec: codec_label(q.codecid).to_string(),
            video_url: q.video_url.clone(),
        })
        .collect();

    // 兜底：极端情况下没有画质列表 → 用主选流构造单条
    if qualities.is_empty() {
        if let Some(url) = streams.video_urls.first() {
            qualities.push(PlayQuality {
                qn: streams.video_qn,
                label: qn_label(streams.video_qn).to_string(),
                codec: codec_label(streams.video_codecid).to_string(),
                video_url: url.clone(),
            });
        }
    }

    let default_qn = qualities.first().map(|q| q.qn).unwrap_or(0);

    Ok(PlayStreams {
        qualities,
        audio_url,
        has_audio,
        default_qn,
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

/// 字幕轨道（供播放器字幕菜单）
#[derive(Serialize)]
pub struct SubtitleTrackDto {
    pub lan: String,
    pub lan_doc: String,
    /// AI 自动生成字幕（播放器里带标注展示；很多视频只有这种）
    pub is_ai: bool,
    /// 字幕 JSON URL（仅回传给 get_subtitle_cues，前端不直接拉取）
    pub subtitle_url: String,
}

/// 获取视频字幕轨道列表（含 AI 字幕 —— 播放场景不过滤；下载路径仍过滤，互不影响）。
/// 未登录或无字幕时返回错误（前端据此禁用字幕菜单）。
#[command]
pub async fn get_subtitle_list(bvid: String, cid: i64, aid: u64) -> Result<Vec<SubtitleTrackDto>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {e}"))?
        .ok_or_else(|| "未登录，请先登录".to_string())?;
    let client = api_client();
    let list = subtitle::get_subtitle_urls_all(&client, &credential, cid, &bvid, aid)
        .await
        .map_err(|e| format!("获取字幕列表失败: {e}"))?;
    Ok(list
        .into_iter()
        .map(|s| {
            let is_ai = s.is_ai_sub(); // 先判定：下面逐字段 move 后 s 不可再借用
            SubtitleTrackDto {
                lan: s.lan,
                lan_doc: s.lan_doc,
                is_ai,
                subtitle_url: s.subtitle_url,
            }
        })
        .collect())
}

/// 拉取单条字幕并解析为 cue 列表（播放器覆盖层按 timeupdate 渲染）。
/// URL 前缀补全（`//` → `https:`）在 Rust 侧完成，前端无需处理。
#[command]
pub async fn get_subtitle_cues(subtitle_url: String) -> Result<Vec<SubtitleCue>, String> {
    let client = api_client();
    subtitle::fetch_subtitle_cues(&client, &subtitle_url)
        .await
        .map_err(|e| format!("获取字幕内容失败: {e}"))
}

/// 在线播放器精准拖动索引：解析 video/audio 两条流的 moov，返回 时间→字节 索引。
/// 前端 seek 时据此跳到目标字节 + 用 timestampOffset 重映射时间。
/// 任一流解析失败返回该字段 None（前端走回退）。命令本身不报错。
#[derive(Serialize)]
pub struct SeekIndexResult {
    pub video: Option<mp4_seek::StreamSeekIndex>,
    pub audio: Option<mp4_seek::StreamSeekIndex>,
}

#[command]
pub async fn get_seek_index(video_url: String, audio_url: String) -> Result<SeekIndexResult, String> {
    let video_fut = async {
        if video_url.is_empty() {
            return None;
        }
        match mp4_seek::fetch_index(&video_url, "video").await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[seek-index] 视频索引获取失败: {e}");
                None
            }
        }
    };
    let audio_fut = async {
        if audio_url.is_empty() {
            return None;
        }
        match mp4_seek::fetch_index(&audio_url, "audio").await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[seek-index] 音频索引获取失败: {e}");
                None
            }
        }
    };
    let (video, audio) = tokio::join!(video_fut, audio_fut);
    Ok(SeekIndexResult { video, audio })
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
