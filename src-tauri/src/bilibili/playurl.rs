use crate::bilibili::credential::Credential;
use crate::bilibili::wbi;
use crate::bilibili::{USER_AGENT, REFERER, ORIGIN};
use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;

/// 构建模拟浏览器的 API 请求头
fn create_api_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
    headers.insert("Accept", HeaderValue::from_static("*/*"));
    headers.insert("Accept-Language", HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
    headers.insert("Referer", HeaderValue::from_static(REFERER));
    headers.insert("Origin", HeaderValue::from_static(ORIGIN));
    headers.insert(
        "sec-ch-ua",
        HeaderValue::from_static(
            "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        ),
    );
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert(
        "sec-ch-ua-platform",
        HeaderValue::from_static("\"Windows\""),
    );
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    headers
}

// ==================== 数据结构 ====================

#[derive(Debug, Deserialize)]
struct PlayUrlResponse {
    code: i64,
    data: Option<PlayUrlData>,
    #[serde(default)]
    result: Option<PlayUrlData>, // 番剧 API 用 result 而非 data
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
    #[serde(default)]
    flac: Option<FlacAudio>,
    #[serde(default)]
    dolby: Option<DolbyAudio>,
}

#[derive(Debug, Deserialize)]
struct FlacAudio {
    audio: Option<DashStream>,
}

#[derive(Debug, Deserialize)]
struct DolbyAudio {
    audio: Option<DashStream>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DashStream {
    pub id: i64,
    pub base_url: String,
    pub backup_url: Option<Vec<String>>,
    // 编解码器 ID: 7=AVC, 12=HEVC, 13=AV1
    #[serde(default)]
    pub codecid: i64,
}

#[derive(Debug, Deserialize)]
struct DurlItem {
    url: String,
    #[serde(default)]
    backup_url: Option<Vec<String>>,
}

/// 选中的音视频流（包含备用 URL）
pub struct SelectedStreams {
    pub video_urls: Vec<String>,
    pub audio_urls: Vec<String>,
    pub is_legacy_format: bool,
}

impl SelectedStreams {
    pub fn has_audio(&self) -> bool {
        !self.audio_urls.is_empty()
    }
}

// ==================== 画质降级链 ====================

const QUALITY_LEVELS: &[i64] = &[
    127, // 8K 超高清
    126, // 杜比视界
    125, // HDR 真彩
    120, // 4K 超清
    116, // 1080P 高帧率
    112, // 1080P 高码率
    80,  // 1080P
    64,  // 720P
    32,  // 480P
    16,  // 360P
];

/// B站 API codec ID → 编解码器名称
fn codec_name(codecid: i64) -> &'static str {
    match codecid {
        7 => "AVC",
        12 => "HEV",
        13 => "AV1",
        _ => "UNKNOWN",
    }
}

// ==================== 核心 API 调用 ====================

/// 获取视频的流地址（带画质降级 + 编解码器优先级 + 番剧 API 回退）
pub async fn get_playurl(
    bvid: &str,
    cid: i64,
    credential: &Credential,
    video_max_qn: i64,
    video_min_qn: i64,
    audio_max_qn: i64,
    audio_min_qn: i64,
    codec_priority: &[String],
) -> Result<SelectedStreams> {
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建HTTP客户端失败")?;

    log::info!(
        "[playurl] 开始获取流地址: bvid={}, cid={}, video_max={}, video_min={}, audio_max={}, audio_min={}",
        bvid, cid, video_max_qn, video_min_qn, audio_max_qn, audio_min_qn
    );

    // 1. 尝试标准 playurl API（带画质降级链）
    match try_playurl_with_fallback(
        &client, bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority,
    )
    .await
    {
        Ok(streams) => return Ok(streams),
        Err(e) => {
            log::warn!("[playurl] 标准API全部失败: {}", e);
        }
    }

    // 2. 尝试番剧 API 回退
    match try_bangumi_playurl(
        &client, bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority,
    )
    .await
    {
        Ok(streams) => return Ok(streams),
        Err(e) => {
            log::warn!("[playurl] 番剧API失败: {}", e);
            anyhow::bail!("获取视频流失败: 标准API和番剧API均失败")
        }
    }
}

/// 标准 playurl API — 带画质降级链
async fn try_playurl_with_fallback(
    client: &Client,
    bvid: &str,
    cid: i64,
    credential: &Credential,
    max_qn: i64,
    min_qn: i64,
    audio_max_qn: i64,
    audio_min_qn: i64,
    codec_priority: &[String],
) -> Result<SelectedStreams> {
    let levels: Vec<i64> = QUALITY_LEVELS
        .iter()
        .filter(|&&q| q <= max_qn)
        .copied()
        .collect();

    let mut last_error = String::new();

    for &qn in &levels {
        match try_playurl_once(client, bvid, cid, qn, credential).await {
            Ok(data) => {
                if let Some(streams) =
                    parse_streams(&data, max_qn, min_qn, audio_max_qn, audio_min_qn, codec_priority)
                {
                    return Ok(streams);
                }
                last_error = "API返回成功但无法解析流".to_string();
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("大会员") || err_str.contains("充电专享") {
                    return Err(e);
                }
                last_error = err_str;
            }
        }
    }

    anyhow::bail!("所有画质等级均失败: {}", last_error)
}

/// 单次 playurl API 请求（WBI 签名 + 重试）
async fn try_playurl_once(
    client: &Client,
    bvid: &str,
    cid: i64,
    qn: i64,
    credential: &Credential,
) -> Result<PlayUrlData> {
    for attempt in 0..2 {
        let mut params = vec![
            ("bvid".to_string(), bvid.to_string()),
            ("cid".to_string(), cid.to_string()),
            ("qn".to_string(), qn.to_string()),
            ("fnval".to_string(), "4048".to_string()),
            ("fourk".to_string(), "1".to_string()),
            ("otype".to_string(), "json".to_string()),
            ("voice_balance".to_string(), "1".to_string()),
            ("gaia_source".to_string(), "pre-load".to_string()),
            ("isGaiaAvoided".to_string(), "true".to_string()),
            ("web_location".to_string(), "1315873".to_string()),
            ("dm_img_str".to_string(), "".to_string()),
            ("dm_cover_img_str".to_string(), "".to_string()),
            ("dm_img_list".to_string(), "[]".to_string()),
            ("dm_img_inter".to_string(), r#"{"ds":[],"wh":[2560,1440,100],"of":[430,798,430]}"#.to_string()),
        ];

        // WBI 签名
        let mixin_key = if attempt == 0 {
            wbi::get_mixin_key_cached(credential).await?
        } else {
            log::info!("[playurl] 刷新WBI密钥重试");
            wbi::refresh_mixin_key(credential).await?
        };
        wbi::sign_params(&mut params, &mixin_key);

        log::info!("[playurl] 请求: qn={}, attempt={}", qn, attempt);

        let resp = client
            .get("https://api.bilibili.com/x/player/wbi/playurl")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await?;

        let status = resp.status();
        if status == reqwest::StatusCode::PRECONDITION_FAILED && attempt == 0 {
            log::warn!("[playurl] HTTP 412, 刷新WBI密钥重试");
            continue;
        }

        let body_text = resp.text().await?;
        log::debug!("[playurl] qn={}, HTTP {}, 响应: {}", qn, status, &body_text[..body_text.len().min(500)]);

        let resp: PlayUrlResponse = serde_json::from_str(&body_text)
            .context(format!("响应解析失败: {}", &body_text[..body_text.len().min(200)]))?;

        if resp.code != 0 {
            let msg = resp.message.unwrap_or_else(|| "未知错误".to_string());
            if resp.code == -404 && attempt == 0 {
                log::warn!("[playurl] API -404, 刷新WBI密钥重试");
                continue;
            }
            anyhow::bail!("qn={} API返回: {}", qn, msg);
        }

        return resp.data.context("playurl 响应无 data");
    }

    anyhow::bail!("WBI签名重试后仍然失败")
}

/// 番剧 API 回退
async fn try_bangumi_playurl(
    client: &Client,
    bvid: &str,
    cid: i64,
    credential: &Credential,
    max_qn: i64,
    min_qn: i64,
    audio_max_qn: i64,
    audio_min_qn: i64,
    codec_priority: &[String],
) -> Result<SelectedStreams> {
    let mut last_error = String::new();

    let levels: Vec<i64> = QUALITY_LEVELS
        .iter()
        .filter(|&&q| q <= max_qn)
        .copied()
        .collect();

    for &qn in &levels {
        let params = vec![
            ("bvid".to_string(), bvid.to_string()),
            ("cid".to_string(), cid.to_string()),
            ("qn".to_string(), qn.to_string()),
            ("fnval".to_string(), "4048".to_string()),
            ("fourk".to_string(), "1".to_string()),
            ("otype".to_string(), "json".to_string()),
        ];

        let resp = client
            .get("https://api.bilibili.com/pgc/player/web/playurl")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await?;

        let body_text = resp.text().await?;
        log::debug!("[bangumi] qn={}, 响应: {}", qn, &body_text[..body_text.len().min(500)]);

        let resp: PlayUrlResponse = serde_json::from_str(&body_text).unwrap_or(PlayUrlResponse {
            code: -1,
            data: None,
            result: None,
            message: Some("解析失败".to_string()),
        });

        if resp.code != 0 {
            last_error = resp.message.unwrap_or_else(|| "未知错误".to_string());
            continue;
        }

        let data = resp.result.or(resp.data).context("番剧 API 响应无数据")?;
        if let Some(streams) =
            parse_streams(&data, max_qn, min_qn, audio_max_qn, audio_min_qn, codec_priority)
        {
            return Ok(streams);
        }
    }

    anyhow::bail!("番剧 API 全部画质失败: {}", last_error)
}

// ==================== 流解析 ====================

fn parse_streams(
    data: &PlayUrlData,
    max_qn: i64,
    min_qn: i64,
    audio_max_qn: i64,
    audio_min_qn: i64,
    codec_priority: &[String],
) -> Option<SelectedStreams> {
    if let Some(ref dash) = data.dash {
        if dash.video.is_empty() {
            return None;
        }

        // 选择画质范围内的最高画质视频流
        let video_stream = dash
            .video
            .iter()
            .filter(|s| s.id <= max_qn && s.id >= min_qn)
            .max_by_key(|s| s.id)
            .or_else(|| dash.video.first())?;

        // 如果有同画质的多个编码流，按编解码器优先级选择
        let video_stream = select_best_codec(dash, video_stream.id, codec_priority)
            .unwrap_or(video_stream);

        let video_urls = build_url_list(&video_stream.base_url, &video_stream.backup_url);

        // 选择音频流：按质量范围过滤
        let audio_urls = select_audio(dash, audio_max_qn, audio_min_qn);

        return Some(SelectedStreams {
            video_urls,
            audio_urls,
            is_legacy_format: false,
        });
    }

    if let Some(ref durl) = data.durl {
        if let Some(first) = durl.first() {
            let video_urls = build_url_list(&first.url, &first.backup_url);
            return Some(SelectedStreams {
                video_urls,
                audio_urls: Vec::new(),
                is_legacy_format: true,
            });
        }
    }

    None
}

/// 在同画质的多个编码流中，按编解码器优先级选择最优的
fn select_best_codec<'a>(
    dash: &'a DashData,
    target_qn: i64,
    codec_priority: &[String],
) -> Option<&'a DashStream> {
    let candidates: Vec<&DashStream> = dash
        .video
        .iter()
        .filter(|s| s.id == target_qn)
        .collect();

    if candidates.len() <= 1 {
        return candidates.into_iter().next();
    }

    // 按编解码器优先级选择：优先级列表中越靠前越优先
    let mut best = candidates[0];
    let mut best_priority = codec_index(codec_name(best.codecid), codec_priority);

    for candidate in &candidates[1..] {
        let priority = codec_index(codec_name(candidate.codecid), codec_priority);
        if priority < best_priority {
            best = candidate;
            best_priority = priority;
        }
    }

    log::info!(
        "[playurl] 编解码器选择: qn={}, codec={} (优先级={})",
        target_qn,
        codec_name(best.codecid),
        best_priority
    );

    Some(best)
}

/// 获取编解码器在优先级列表中的位置（越小越优先）
fn codec_index(codec: &str, priority: &[String]) -> usize {
    priority
        .iter()
        .position(|p| p == codec)
        .unwrap_or(usize::MAX)
}

/// 选择音频流：按质量范围过滤，选最高质量
fn select_audio(dash: &DashData, max_qn: i64, min_qn: i64) -> Vec<String> {
    // 收集所有音频流
    let mut all_audio: Vec<&DashStream> = Vec::new();
    all_audio.extend(dash.audio.iter());
    if let Some(ref flac) = dash.flac {
        if let Some(ref audio) = flac.audio {
            all_audio.push(audio);
        }
    }
    if let Some(ref dolby) = dash.dolby {
        if let Some(ref audio) = dolby.audio {
            all_audio.push(audio);
        }
    }

    // 按质量范围过滤后选最高质量
    let best = all_audio
        .iter()
        .filter(|s| {
            let id = s.id;
            (min_qn == 0 || id >= min_qn) && (max_qn == 0 || id <= max_qn)
        })
        .max_by_key(|s| s.id);

    if let Some(audio) = best {
        return build_url_list(&audio.base_url, &audio.backup_url);
    }

    // 没有符合范围的，退而求其次选最高质量的
    if let Some(audio) = all_audio.iter().max_by_key(|s| s.id) {
        return build_url_list(&audio.base_url, &audio.backup_url);
    }

    Vec::new()
}

fn build_url_list(primary: &str, backup: &Option<Vec<String>>) -> Vec<String> {
    let mut urls = vec![primary.to_string()];
    if let Some(ref backups) = backup {
        urls.extend(backups.iter().cloned());
    }
    urls.sort_by(|a, b| {
        let score = |url: &str| -> i32 {
            if url.contains("upos") { 0 }
            else if url.contains("cn-") { 1 }
            else if url.contains("mcdn") { 3 }
            else { 2 }
        };
        score(a).cmp(&score(b))
    });
    urls
}
