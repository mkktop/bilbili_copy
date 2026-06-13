use anyhow::Context;
use serde::Deserialize;

use crate::bilibili::credential::Credential;
use crate::bilibili::wbi::{self, create_api_headers};
use crate::bilibili::{http_to_https, USER_AGENT};

// ==================== 响应结构体 ====================

#[derive(Debug, Deserialize)]
struct PlayerV2Response {
    code: i64,
    data: Option<PlayerV2Data>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlayerV2Data {
    #[serde(default)]
    subtitle: Option<SubtitleData>,
}

#[derive(Debug, Deserialize)]
struct SubtitleData {
    #[serde(default)]
    subtitles: Vec<SubtitleInfo>,
}

/// 字幕条目（公开）
#[derive(Debug, Deserialize, Clone)]
pub struct SubtitleInfo {
    /// 语言代码，如 "zh-Hans", "en"
    #[serde(default)]
    pub lan: String,
    /// 语言描述，如 "中文（自动生成）"
    #[serde(default)]
    pub lan_doc: String,
    /// 字幕内容 URL，格式如 "//aisubtitle.hdslb.com/..."
    #[serde(default)]
    pub subtitle_url: String,
}

impl SubtitleInfo {
    /// 判断是否为 AI 生成的字幕
    pub fn is_ai_sub(&self) -> bool {
        self.subtitle_url.contains("ai_subtitle")
    }
}

#[derive(Debug, Deserialize)]
struct SubtitleContent {
    #[serde(default)]
    body: Vec<SubtitleItem>,
}

#[derive(Debug, Deserialize)]
struct SubtitleItem {
    from: f64,
    to: f64,
    content: String,
}

// ==================== 公开 API ====================

/// 从 `/x/player/wbi/v2` 获取可用字幕列表
///
/// 需要 WBI 签名，参数: cid, bvid, aid
pub async fn get_subtitle_urls(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    bvid: &str,
    aid: u64,
) -> anyhow::Result<Vec<SubtitleInfo>> {
    for attempt in 0..2 {
        let mut params = vec![
            ("cid".to_string(), cid.to_string()),
            ("bvid".to_string(), bvid.to_string()),
            ("aid".to_string(), aid.to_string()),
        ];

        let mixin_key = if attempt == 0 {
            wbi::get_mixin_key_cached(credential).await?
        } else {
            log::info!("[subtitle] 刷新WBI密钥重试");
            wbi::refresh_mixin_key(credential).await?
        };
        wbi::sign_params(&mut params, &mixin_key);

        let resp = client
            .get("https://api.bilibili.com/x/player/wbi/v2")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await
            .context("请求字幕列表失败")?;

        let status = resp.status();
        if status == reqwest::StatusCode::PRECONDITION_FAILED && attempt == 0 {
            log::warn!("[subtitle] HTTP 412, 刷新WBI密钥重试");
            continue;
        }

        let body_text = resp.text().await?;
        let parsed: PlayerV2Response = serde_json::from_str(&body_text)
            .context("字幕列表响应解析失败")?;

        if parsed.code != 0 {
            if parsed.code == -404 && attempt == 0 {
                log::warn!("[subtitle] API -404, 刷新WBI密钥重试");
                continue;
            }
            let msg = parsed.message.unwrap_or_else(|| "未知错误".to_string());
            anyhow::bail!("获取字幕列表失败: {}", msg);
        }

        let subtitles = parsed
            .data
            .and_then(|d| d.subtitle)
            .map(|s| s.subtitles)
            .unwrap_or_default();

        // 过滤掉 AI 生成的字幕
        let subtitles: Vec<SubtitleInfo> = subtitles
            .into_iter()
            .filter(|v| !v.is_ai_sub())
            .collect();

        log::info!("[subtitle] 获取到 {} 条字幕（已过滤AI字幕）", subtitles.len());
        return Ok(subtitles);
    }

    anyhow::bail!("WBI签名重试后仍然失败")
}

/// 下载单条字幕并转换为 SRT 格式
pub async fn fetch_subtitle_srt(
    client: &reqwest::Client,
    subtitle_url: &str,
) -> anyhow::Result<String> {
    // 补全 URL 前缀（API 返回 //aisubtitle.hdslb.com/... 格式）
    let url = if subtitle_url.starts_with("//") {
        format!("https:{}", subtitle_url)
    } else {
        http_to_https(subtitle_url)
    };

    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .context("请求字幕内容失败")?;

    let body_text = resp.text().await?;
    let content: SubtitleContent = serde_json::from_str(&body_text)
        .context("字幕内容解析失败")?;

    Ok(to_srt(&content.body))
}

// ==================== SRT 格式转换 ====================

/// 将秒数格式化为 SRT 时间格式 `HH:MM:SS,mmm`
fn format_srt_time(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round() as u64;
    let h = total_ms / 3_600_000;
    let m = (total_ms % 3_600_000) / 60_000;
    let s = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// 将字幕条目列表转换为 SRT 文本
fn to_srt(items: &[SubtitleItem]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                format_srt_time(item.from),
                format_srt_time(item.to),
                item.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
