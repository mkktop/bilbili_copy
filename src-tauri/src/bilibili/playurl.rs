use crate::bilibili::credential::Credential;
use crate::bilibili::risk_control;
use crate::bilibili::wbi;
use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;

/// 构建模拟浏览器的 API 请求头（公共头 + playurl 专属的 gaia_vtoken）
fn create_api_headers() -> HeaderMap {
    let mut headers = crate::bilibili::create_api_headers();
    // 如果有缓存的 gaia_vtoken，带上
    if let Some(token) = risk_control::get_gaia_vtoken() {
        if let Ok(val) = HeaderValue::from_str(&token) {
            headers.insert("x-gaia-vtoken", val);
        }
    }
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
    /// 风控验证码凭证（存在则需完成验证码）
    #[serde(default)]
    v_voucher: Option<String>,
    /// 试看标记（番剧会员集：无权限时 code=0 但只给几分钟试看流，1=试看）。
    /// 不检测会把试看片段当正片下载/播放，用户拿到残缺视频却无提示。
    #[serde(default)]
    is_preview: Option<i64>,
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

/// 一个可选画质（某 qn 下按编解码器优先级选出的流）
#[derive(Debug, Clone)]
pub struct QualityInfo {
    pub qn: i64,
    pub codecid: i64,
    pub video_url: String,
}

/// 选中的音视频流（包含备用 URL）
#[derive(Debug)]
pub struct SelectedStreams {
    pub video_urls: Vec<String>,
    pub audio_urls: Vec<String>,
    pub is_legacy_format: bool,
    /// 选中视频流的画质 id（QN）。用于跨会话续传指纹与持久化。
    /// legacy 格式（durl）没有画质 id，此处为 0。
    pub video_qn: i64,
    /// 选中视频流的编解码器 id（7=AVC,12=HEVC,13=AV1）。用于续传指纹。legacy 为 0。
    pub video_codecid: i64,
    /// 选中音频流的 id（如 30280 Hi-Res、30251 Dolby 等）。用于音频流续传指纹。无音频为 0。
    pub audio_id: i64,
    /// 所有可选画质（按 qn 降序，仅含 codec_priority 命中的编码）。
    /// 在线播放器用它构建画质菜单；下载路径不使用。
    pub all_qualities: Vec<QualityInfo>,
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

/// B站 API codec ID → 编解码器名称。
/// 注意用 "HEV"（B站 settings/前端一致的短名）：这是全项目唯一的 codecid→名称
/// 映射，展示与匹配共用，避免两套命名改一处漏一处导致编码永远选不中。
pub fn codec_name(codecid: i64) -> &'static str {
    match codecid {
        7 => "AVC",
        12 => "HEV",
        13 => "AV1",
        _ => "UNKNOWN",
    }
}

/// 试看流检测：番剧会员集无权限时 API 返回 code=0 + is_preview=1（只有几分钟片段）。
/// 命中时报硬错误，避免把试看片段当正片下载/播放。
fn check_preview(data: &PlayUrlData) -> Result<()> {
    if data.is_preview == Some(1) {
        anyhow::bail!("该视频为大会员专享，当前账号仅能获取试看片段，已取消");
    }
    Ok(())
}

/// 会员/付费类硬错误：重试其它画质无意义，应立即向上抛出（避免无效请求触发风控）
fn is_vip_error(msg: &str) -> bool {
    msg.contains("大会员") || msg.contains("充电专享") || msg.contains("付费") || msg.contains("专享限制")
}

/// 与画质无关的硬错误：换档位重试同样会失败，逐档降级只会连发无效请求
/// （最坏 9 档 × 2 次 WBI 重试 + 番剧侧 10 档 ≈ 28 次），还推高风控概率。
/// 覆盖：会员/付费类 + 登录过期(-101) + 风控校验(-352) + 参数错误(-400) + 拦截(-412)。
fn is_hard_error(msg: &str) -> bool {
    is_vip_error(msg)
        || msg.contains("-101")
        || msg.contains("账号未登录")
        || msg.contains("-352")
        || msg.contains("风控校验失败")
        || msg.contains("-400")
        || msg.contains("请求错误")
        || msg.contains("-412")
        || msg.contains("请求被拦截")
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
    ep_id: Option<u64>,
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
    request_delay_ms: u64,
) -> Result<SelectedStreams> {
    // 共享 api_client()：连接池复用，解析链路（view→playurl）不重复握手
    let client = crate::bilibili::api_client();

    log::info!(
        "[playurl] 开始获取流地址: bvid={}, cid={}, ep_id={:?}, video_max={}, video_min={}, audio_max={}, audio_min={}",
        bvid, cid, ep_id, video_max_qn, video_min_qn, audio_max_qn, audio_min_qn
    );

    // 1. 尝试标准 playurl API（带画质降级链）
    let std_result = try_playurl_with_fallback(
        &client, bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority,
        dm_img_str, dm_cover_img_str, dm_img_list, dm_img_inter, request_delay_ms,
    )
    .await;
    if let Ok(streams) = std_result {
        return Ok(streams);
    }
    let std_err = std_result.unwrap_err();
    log::warn!("[playurl] 标准API全部失败: {}", std_err);

    // 2. 尝试番剧 API 回退
    match try_bangumi_playurl(
        &client, bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority, ep_id,
        dm_img_str, dm_cover_img_str, dm_img_list, dm_img_inter, request_delay_ms,
    )
    .await
    {
        Ok(streams) => Ok(streams),
        Err(e) => {
            log::warn!("[playurl] 番剧API失败: {}", e);
            // 透传真实失败原因（如「大会员专享限制」），而非笼统的「均失败」——
            // 否则会员集无权限时用户看不到真实原因，前端也无法映射友好文案。
            // UGC 视频（无 ep_id）在番剧 API 上必然失败：报标准 API 的真实原因，
            // 避免用户看到误导性的「番剧 API 全部画质失败」。
            if ep_id.is_none() {
                anyhow::bail!("获取视频流失败: {}", std_err)
            }
            anyhow::bail!("获取视频流失败: {}", e)
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
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
    request_delay_ms: u64,
) -> Result<SelectedStreams> {
    // 快路径：单次请求最高画质。fnval=4048 响应的 dash.video 已含所有可用画质，
    // parse_streams 会在 [min_qn, max_qn] 范围内挑最优——绝大多数情况一次请求即可，
    // 避免逐档降级的多次往返与更高的风控触发概率。
    // 仅当单次请求拿不到流、或遇到可降级的错误时，才落到下方逐档兜底。
    // （大会员/充电专享属于硬错误，立即向上抛出。）
    match try_playurl_once(client, bvid, cid, max_qn, credential, dm_img_str, dm_cover_img_str, dm_img_list, dm_img_inter).await {
        Ok(data) => {
            if let Some(vv) = data.v_voucher.as_deref() {
                if !vv.is_empty() {
                    log::warn!("[playurl] 检测到风控 v_voucher: {}", &vv.chars().take(20).collect::<String>());
                    anyhow::bail!("RISK_CONTROL:{}", vv);
                }
            }
            check_preview(&data)?; // 试看流：硬错误，不降级重试
            if let Some(streams) = parse_streams(&data, max_qn, min_qn, audio_max_qn, audio_min_qn, codec_priority) {
                log::info!("[playurl] 单次请求命中: qn={}", streams.video_qn);
                return Ok(streams);
            }
            log::warn!("[playurl] 单次请求无法解析流，回退逐档降级");
        }
        Err(e) => {
            let err_str = e.to_string();
            if is_hard_error(&err_str) || err_str.contains("试看") {
                return Err(e);
            }
            log::warn!("[playurl] 单次请求失败，回退逐档降级: {}", e);
        }
    }

    // 兜底：逐档降级请求，应对单次请求拿不到流的边界情况。
    // 快路径已试过 max_qn，这里排除掉以避免重复请求。
    let levels: Vec<i64> = QUALITY_LEVELS
        .iter()
        .filter(|&&q| q < max_qn)
        .copied()
        .collect();

    let mut last_error = String::new();

    for &qn in &levels {
        // 请求间隔
        if request_delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(request_delay_ms)).await;
        }
        match try_playurl_once(client, bvid, cid, qn, credential, dm_img_str, dm_cover_img_str, dm_img_list, dm_img_inter).await {
            Ok(data) => {
                // 检测风控 v_voucher
                if let Some(vv) = data.v_voucher.as_deref() {
                    if !vv.is_empty() {
                        log::warn!("[playurl] 检测到风控 v_voucher: {}", &vv.chars().take(20).collect::<String>());
                        anyhow::bail!("RISK_CONTROL:{}", vv);
                    }
                }
                check_preview(&data)?; // 试看流：硬错误，不继续降级
                if let Some(streams) =
                    parse_streams(&data, max_qn, min_qn, audio_max_qn, audio_min_qn, codec_priority)
                {
                    return Ok(streams);
                }
                last_error = "API返回成功但无法解析流".to_string();
            }
            Err(e) => {
                let err_str = e.to_string();
                if is_hard_error(&err_str) || err_str.contains("试看") {
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
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
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
            ("dm_img_str".to_string(), if dm_img_str.is_empty() { "".to_string() } else { dm_img_str.to_string() }),
            ("dm_cover_img_str".to_string(), if dm_cover_img_str.is_empty() { "".to_string() } else { dm_cover_img_str.to_string() }),
            ("dm_img_list".to_string(), if dm_img_list.is_empty() { "[]".to_string() } else { dm_img_list.to_string() }),
            ("dm_img_inter".to_string(), if dm_img_inter.is_empty() { r#"{"ds":[],"wh":[2560,1440,100],"of":[430,798,430]}"#.to_string() } else { dm_img_inter.to_string() }),
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
        log::debug!("[playurl] qn={}, HTTP {}, 响应: {}", qn, status, &body_text.chars().take(500).collect::<String>());

        let resp: PlayUrlResponse = serde_json::from_str(&body_text)
            .context(format!("响应解析失败: {}", &body_text.chars().take(200).collect::<String>()))?;

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
    ep_id: Option<u64>,
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
    request_delay_ms: u64,
) -> Result<SelectedStreams> {
    let mut last_error = String::new();

    let levels: Vec<i64> = QUALITY_LEVELS
        .iter()
        .filter(|&&q| q <= max_qn)
        .copied()
        .collect();

    for &qn in &levels {
        // 请求间隔
        if request_delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(request_delay_ms)).await;
        }
        let mut params = vec![
            ("cid".to_string(), cid.to_string()),
            ("qn".to_string(), qn.to_string()),
            ("fnval".to_string(), "4048".to_string()),
            ("fourk".to_string(), "1".to_string()),
            ("otype".to_string(), "json".to_string()),
            ("gaia_source".to_string(), "pre-load".to_string()),
            ("isGaiaAvoided".to_string(), "true".to_string()),
            ("web_location".to_string(), "1315873".to_string()),
            ("dm_img_str".to_string(), if dm_img_str.is_empty() { "".to_string() } else { dm_img_str.to_string() }),
            ("dm_cover_img_str".to_string(), if dm_cover_img_str.is_empty() { "".to_string() } else { dm_cover_img_str.to_string() }),
            ("dm_img_list".to_string(), if dm_img_list.is_empty() { "[]".to_string() } else { dm_img_list.to_string() }),
            ("dm_img_inter".to_string(), if dm_img_inter.is_empty() { r#"{"ds":[],"wh":[2560,1440,100],"of":[430,798,430]}"#.to_string() } else { dm_img_inter.to_string() }),
        ];

        // 番剧 API 优先用 ep_id，其次用 bvid
        if let Some(ep) = ep_id {
            params.push(("ep_id".to_string(), ep.to_string()));
        } else {
            params.push(("bvid".to_string(), bvid.to_string()));
        }

        let resp = client
            .get("https://api.bilibili.com/pgc/player/web/playurl")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await?;

        let body_text = resp.text().await?;
        log::debug!("[bangumi] qn={}, 响应: {}", qn, &body_text.chars().take(500).collect::<String>());

        let resp: PlayUrlResponse = serde_json::from_str(&body_text).unwrap_or(PlayUrlResponse {
            code: -1,
            data: None,
            result: None,
            message: Some("解析失败".to_string()),
        });

        if resp.code != 0 {
            last_error = resp.message.unwrap_or_else(|| "未知错误".to_string());
            // 硬错误（会员/付费/登录过期/风控/参数错）：其它画质同样失败，立即退出
            // 避免剩余档位的无效请求
            if is_hard_error(&last_error) {
                anyhow::bail!("{}", last_error);
            }
            continue;
        }

        let data = resp.result.or(resp.data).context("番剧 API 响应无数据")?;
        // 检测风控 v_voucher
        if let Some(vv) = data.v_voucher.as_deref() {
            if !vv.is_empty() {
                log::warn!("[bangumi] 检测到风控 v_voucher");
                anyhow::bail!("RISK_CONTROL:{}", vv);
            }
        }
        check_preview(&data)?; // 试看流：会员集无权限时 code=0 但只给试看片段，硬错误
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

        // 选择画质范围内的最高画质视频流。范围内无可选流时兜底：
        // ① ≤max_qn 的最高档（尊重上限——用户限 480P 省流量时不偷偷拿高清流）；
        // ② 所有流都超上限时取最低画质并打 warn（总得能下）。
        // 绝不静默取 dash.video.first()（B站返回的第一条通常是最高画质）。
        let video_stream = dash
            .video
            .iter()
            .filter(|s| s.id <= max_qn && s.id >= min_qn)
            .max_by_key(|s| s.id)
            .or_else(|| {
                let capped = dash.video.iter().filter(|s| s.id <= max_qn).max_by_key(|s| s.id);
                if capped.is_some() {
                    log::warn!("[playurl] [min_qn={}, max_qn={}] 范围内无画质，兜底到上限内最高档（低于 min_qn）", min_qn, max_qn);
                }
                capped
            })
            .or_else(|| {
                let lowest = dash.video.iter().min_by_key(|s| s.id)?;
                log::warn!(
                    "[playurl] 无 ≤max_qn={} 的画质可用，兜底取最低画质 qn={}（超出用户上限）",
                    max_qn, lowest.id
                );
                Some(lowest)
            })?;

        // 如果有同画质的多个编码流，按编解码器优先级选择
        let video_stream = select_best_codec(dash, video_stream.id, codec_priority)
            .unwrap_or(video_stream);

        let video_qn = video_stream.id;
        let video_codecid = video_stream.codecid;
        let video_urls = build_url_list(&video_stream.base_url, &video_stream.backup_url);

        // 选择音频流：按质量范围过滤（返回 URL 列表与流 id）
        let (audio_urls, audio_id) = select_audio(dash, audio_max_qn, audio_min_qn);

        // 收集所有可选画质（仅 codec_priority 命中的编码，按 qn 降序），供在线播放器画质菜单使用
        let all_qualities = collect_qualities(dash, codec_priority);

        return Some(SelectedStreams {
            video_urls,
            audio_urls,
            is_legacy_format: false,
            video_qn,
            video_codecid,
            audio_id,
            all_qualities,
        });
    }

    if let Some(ref durl) = data.durl {
        if let Some(first) = durl.first() {
            let video_urls = build_url_list(&first.url, &first.backup_url);
            return Some(SelectedStreams {
                video_urls,
                audio_urls: Vec::new(),
                is_legacy_format: true,
                video_qn: 0,
                video_codecid: 0,
                audio_id: 0,
                all_qualities: Vec::new(),
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

/// 收集所有可选画质（仅含 codec_priority 命中的编码），按 qn 降序。
/// 每个 qn 取优先级最高的编码流（在线播放器只需 AVC 时，便只返回有 AVC 的画质）。
fn collect_qualities(dash: &DashData, codec_priority: &[String]) -> Vec<QualityInfo> {
    // qn → 当前最优（priority index 最小）的流
    let mut best_by_qn: std::collections::BTreeMap<i64, (usize, &DashStream)> =
        std::collections::BTreeMap::new();
    for s in &dash.video {
        let pri = codec_index(codec_name(s.codecid), codec_priority);
        if pri == usize::MAX {
            continue; // 该编码不在优先级列表（如只要 AVC，跳过 HEVC/AV1）
        }
        match best_by_qn.get(&s.id) {
            Some((existing_pri, _)) if *existing_pri <= pri => {}
            _ => {
                best_by_qn.insert(s.id, (pri, s));
            }
        }
    }
    let mut out: Vec<QualityInfo> = best_by_qn
        .into_iter()
        .map(|(qn, (_, s))| QualityInfo {
            qn,
            codecid: s.codecid,
            video_url: s.base_url.clone(),
        })
        .collect();
    // BTreeMap 按 qn 升序，翻转成降序（最高画质在前）
    out.reverse();
    out
}

/// 选择音频流：按质量范围过滤，选最高质量。返回 (URL 列表, 流 id)。
fn select_audio(dash: &DashData, max_qn: i64, min_qn: i64) -> (Vec<String>, i64) {
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
        return (build_url_list(&audio.base_url, &audio.backup_url), audio.id);
    }

    // 范围内没有：兜底仍尊重上限（max_qn>0 时选 ≤max_qn 的最高音质），
    // 不能静默取全场最高（那通常是 Hi-Res/Dolby，超出用户设置）。
    let fallback = if max_qn > 0 {
        all_audio.iter().filter(|s| s.id <= max_qn).max_by_key(|s| s.id)
    } else {
        None
    };
    let fallback = match fallback {
        Some(a) => Some(a),
        None => {
            log::warn!("[playurl] 音频范围内无可用流，兜底取最高音质（可能超出设置范围）");
            all_audio.iter().max_by_key(|s| s.id)
        }
    };
    if let Some(audio) = fallback {
        return (build_url_list(&audio.base_url, &audio.backup_url), audio.id);
    }

    (Vec::new(), 0)
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
