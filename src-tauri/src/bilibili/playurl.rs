use crate::bilibili::credential::Credential;
use crate::bilibili::url::bvid_to_aid;
use crate::bilibili::wbi;
use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";

#[derive(Debug, Deserialize)]
struct PlayUrlResponse {
    code: i64,
    data: Option<PlayUrlData>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlayUrlData {
    #[serde(default)]
    dash: Option<DashData>,
    #[serde(default)]
    durl: Option<Vec<DurlItem>>,
}

#[derive(Debug, Deserialize)]
struct DashData {
    #[serde(default)]
    video: Vec<DashStream>,
    #[serde(default)]
    audio: Vec<DashStream>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct DashStream {
    pub id: i64,
    pub base_url: String,
    pub backup_url: Option<Vec<String>>,
    pub codecid: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DurlItem {
    url: String,
    #[serde(default)]
    backup_url: Option<Vec<String>>,
}

/// 选中的音视频流
pub struct SelectedStreams {
    pub video_url: String,
    pub audio_url: Option<String>, // 部分视频可能无独立音频流
}

/// 获取视频的DASH流地址
pub async fn get_playurl(
    bvid: &str,
    cid: i64,
    credential: &Credential,
) -> Result<SelectedStreams> {
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建HTTP客户端失败")?;

    let aid = bvid_to_aid(bvid);

    // 构建参数
    let mut params = vec![
        ("avid".to_string(), aid.to_string()),
        ("cid".to_string(), cid.to_string()),
        ("qn".to_string(), "80".to_string()),       // 1080P
        ("fnval".to_string(), "4048".to_string()),   // DASH格式
        ("fourk".to_string(), "1".to_string()),      // 允许4K
        ("otype".to_string(), "json".to_string()),
    ];

    // WBI签名
    let mixin_key = wbi::get_mixin_key_cached(credential).await?;
    wbi::sign_params(&mut params, &mixin_key);

    let resp: PlayUrlResponse = client
        .get("https://api.bilibili.com/x/player/wbi/playurl")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&params)
        .send()
        .await?
        .json()
        .await?;

    if resp.code != 0 {
        anyhow::bail!(
            "获取视频流失败: {}",
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

    let data = resp.data.context("playurl响应无data")?;

    // 优先处理DASH格式
    if let Some(dash) = data.dash {
        if dash.video.is_empty() {
            anyhow::bail!("未获取到视频流，可能是大会员专属视频");
        }

        // 选择最高质量的视频流（id越大质量越高，但不超过80=1080P）
        let video_stream = dash
            .video
            .iter()
            .filter(|s| s.id <= 80)
            .max_by_key(|s| s.id)
            .or_else(|| dash.video.first())
            .context("无可用视频流")?;

        // 选择最高质量的音频流
        let audio_url = dash
            .audio
            .iter()
            .max_by_key(|s| s.id)
            .map(|s| s.base_url.clone());

        return Ok(SelectedStreams {
            video_url: video_stream.base_url.clone(),
            audio_url,
        });
    }

    // 回退处理旧格式（durl）
    if let Some(durl) = data.durl {
        if let Some(first) = durl.first() {
            return Ok(SelectedStreams {
                video_url: first.url.clone(),
                audio_url: None,
            });
        }
    }

    anyhow::bail!("无法获取视频流地址")
}
