use crate::bilibili::credential::Credential;
use crate::bilibili::url::bvid_to_aid;
use crate::bilibili::wbi;
use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";
const ORIGIN: &str = "https://www.bilibili.com";

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

// ==================== 反风控参数 ====================

/// 静态 WebGL 指纹（模拟 Chrome + RTX 4070 Ti）
/// base64("WebGL 1.0 | Version: WebGL 1.0, Vendor: WebKit, Renderer: WebKit WebGL, GLSL: WebGL GLSL ES 1.0 | WebKit WebGL | GLSL: WebGL GLSL ES 1.0 | Extensions: ANGLE_instanced_arrays EXT_blend_minmax EXT_color_buffer_half_float EXT_disjoint_timer_query EXT_float_blend EXT_frag_depth EXT_shader_texture_lod EXT_texture_compression_bptc EXT_texture_compression_rgtc EXT_texture_filter_anisotropic WEBKIT_EXT_texture_filter_anisotropic EXT_sRGB KHR_parallel_shader_compile OES_element_index_uint OES_fbo_render_mipmap OES_standard_derivatives OES_texture_float OES_texture_float_linear OES_texture_half_float OES_texture_half_float_linear OES_vertex_array_object WEBGL_color_buffer_float WEBGL_compressed_texture_s3tc WEBGL_compressed_texture_s3tc_srgb WEBGL_debug_renderer_info WEBGL_debug_shaders WEBGL_depth_texture WEBGL_draw_buffers WEBGL_lose_context WEBGL_multi_draw")
const DM_IMG_STR: &str = "V2ViR0wgMS4wIHwgVmVyc2lvbjogV2ViR0wgMS4wLCBWZW5kb3I6IFdlYktpdCwgUmVuZGVyZXI6IFdlYktpdCBXZWJHTCwgR0xTTDogV2ViR0wgR0xTTCBFUyAxLjAgfCBXZWJLaXQgV2ViR0wgfCBHTFNMOiBXZWJHTCBHTFNMIEVTIDEuMCB8IEV4dGVuc2lvbnM6IEFOR0xFX2luc3RhbmNlZF9hcnJheXMgRVhUX2JsZW5kX21pbm1heCBFWFRfY29sb3JfYnVmZmVyX2hhbGZfZmxvYXQgRVhUX2Rpc2pvaW50X3RpbWVyX3F1ZXJ5IEVYVF9mbG9hdF9ibGVuZCBFWFRfZnJhZ19kZXB0aCBFWFRfc2hhZGVyX3RleHR1cmVfbG9kIEVYVF90ZXh0dXJlX2NvbXByZXNzaW9uX2JwdGMgRVhUX3RleHR1cmVfY29tcHJlc3Npb25fcmd0YyBFWFRfdGV4dHVyZV9maWx0ZXJfYW5pc290cm9waWMgV0VCS0lUX0VYVF90ZXh0dXJlX2ZpbHRlcl9hbmlzb3Ryb3BpYyBFWFRfc1JHQiBLSFJfcGFyYWxsZWxfc2hhZGVyX2NvbXBpbGUgT0VTX2VsZW1lbnRfaW5kZXhfdWludCBPRVNfZmJvX3JlbmRlcl9taXBtYXAgT0VTX3N0YW5kYXJkX2Rlcml2YXRpdmVzIE9FU190ZXh0dXJlX2Zsb2F0IE9FU190ZXh0dXJlX2Zsb2F0X2xpbmVhciBPRVNfdGV4dHVyZV9oYWxmX2Zsb2F0IE9FU190ZXh0dXJlX2hhbGZfZmxvYXRfbGluZWFyIE9FU192ZXJ0ZXhfYXJyYXlfb2JqZWN0IFdFQkdsX2NvbG9yX2J1ZmZlcl9mbG9hdCBXRUJHTF9jb21wcmVzc2VkX3RleHR1cmVfczN0YyBXRUJHTF9jb21wcmVzc2VkX3RleHR1cmVfczN0Y19zcmdiIFdFQkdsX2RlYnVnX3JlbmRlcmVyX2luZm8gV0VCR0xfZGVidWdfc2hhZGVycyBXRUJHTF9kZXB0aF90ZXh0dXJlIFdFQkdsX2RyYXdfYnVmZmVycyBXRUJHTF9sb3NlX2NvbnRleHQgV0VCR0xfbXVsdGlfZHJhdw==";

/// 静态 GPU 指纹（模拟 NVIDIA RTX 4070 Ti SUPER）
/// base64("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002705) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA) | NVIDIA NVIDIA GeForce RTX 4070 Ti SUPER 0x00002705 | Device: 0x00002705 | Driver: vs_5_0 ps_5_0 | DirectX: Direct3D11")
const DM_COVER_IMG_STR: &str = "QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgUlRYIDQwNzAgVGkgU1VQRVIgKDB4MDAwMDI3MDUpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE5WSURJQSl8IE5WSURJQSBOVklESUEgR2VGb3JjZSBSVFggNDA3MCBUaSBTVVBFUiAweDAwMDAyNzA1IHwgRGV2aWNlOiAweDAwMDAyNzA1IHwgRHJpdmVyOiB2c181XzAgcHNfNV8wIHwgRGlyZWN0WDogRGlyZWN0M0QxMQ==";

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
}

#[derive(Debug, Deserialize)]
struct DurlItem {
    url: String,
    #[serde(default)]
    backup_url: Option<Vec<String>>,
}

/// 选中的音视频流（包含备用 URL）
pub struct SelectedStreams {
    /// 视频流 URL 列表（主 URL + 备用 URL）
    pub video_urls: Vec<String>,
    /// 音频流 URL 列表（主 URL + 备用 URL）
    pub audio_urls: Vec<String>,
    /// 是否为 FLV/durl 旧格式（需要转封装）
    pub is_legacy_format: bool,
}

impl SelectedStreams {
    /// 是否有音频流
    pub fn has_audio(&self) -> bool {
        !self.audio_urls.is_empty()
    }
}

// ==================== 画质降级链 ====================

/// 画质等级（从高到低）
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

// ==================== 核心 API 调用 ====================

/// 获取视频的流地址（带画质降级 + 番剧 API 回退）
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

    // 1. 尝试标准 playurl API（带画质降级链）
    match try_playurl_with_fallback(&client, aid, cid, credential).await {
        Ok(streams) => return Ok(streams),
        Err(e) => {
            eprintln!("标准 playurl 全部失败: {}, 尝试番剧 API...", e);
        }
    }

    // 2. 尝试番剧 API 回退
    match try_bangumi_playurl(&client, aid, cid, credential).await {
        Ok(streams) => return Ok(streams),
        Err(e) => {
            eprintln!("番剧 API 也失败: {}", e);
        }
    }

    anyhow::bail!("无法获取视频流地址（标准 API 和番剧 API 均失败）")
}

/// 标准播放URL API — 带画质降级链
async fn try_playurl_with_fallback(
    client: &Client,
    aid: u64,
    cid: i64,
    credential: &Credential,
) -> Result<SelectedStreams> {
    let mut last_error = String::new();

    for &qn in QUALITY_LEVELS {
        match try_playurl_once(client, aid, cid, qn, credential).await {
            Ok(data) => {
                if let Some(streams) = parse_streams(&data) {
                    return Ok(streams);
                }
                last_error = "API 返回成功但无法解析流".to_string();
            }
            Err(e) => {
                let err_str = e.to_string();
                // 这些错误不需要继续降级
                if err_str.contains("大会员") || err_str.contains("充电专享") {
                    return Err(e);
                }
                last_error = err_str;
            }
        }
    }

    anyhow::bail!("所有画质等级均失败: {}", last_error)
}

/// 单次 playurl API 请求（带 WBI 重试）
async fn try_playurl_once(
    client: &Client,
    aid: u64,
    cid: i64,
    qn: i64,
    credential: &Credential,
) -> Result<PlayUrlData> {
    for attempt in 0..2 {
        let mut params = vec![
            ("avid".to_string(), aid.to_string()),
            ("cid".to_string(), cid.to_string()),
            ("qn".to_string(), qn.to_string()),
            ("fnval".to_string(), "4048".to_string()),
            ("fourk".to_string(), "1".to_string()),
            ("otype".to_string(), "json".to_string()),
            ("voice_balance".to_string(), "1".to_string()),
            ("gaia_source".to_string(), "pre-load".to_string()),
            ("isGaiaAvoided".to_string(), "true".to_string()),
            ("web_location".to_string(), "1315873".to_string()),
            ("dm_img_str".to_string(), DM_IMG_STR.to_string()),
            ("dm_cover_img_str".to_string(), DM_COVER_IMG_STR.to_string()),
            ("dm_img_list".to_string(), "[]".to_string()),
            ("dm_img_inter".to_string(), r#"{"ds":[],"wh":[2560,1440,100],"of":[430,798,430]}"#.to_string()),
        ];

        let mixin_key = if attempt == 0 {
            wbi::get_mixin_key_cached(credential).await?
        } else {
            wbi::refresh_mixin_key(credential).await?
        };
        wbi::sign_params(&mut params, &mixin_key);

        let resp = client
            .get("https://api.bilibili.com/x/player/wbi/playurl")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await?;

        // 412 = WBI 签名过期，刷新密钥重试
        if resp.status() == reqwest::StatusCode::PRECONDITION_FAILED && attempt == 0 {
            continue;
        }

        let resp: PlayUrlResponse = resp.json().await?;

        if resp.code != 0 {
            let msg = resp.message.unwrap_or_else(|| "未知错误".to_string());
            // -404 可能是签名问题，尝试刷新密钥
            if resp.code == -404 && attempt == 0 {
                continue;
            }
            anyhow::bail!("{}", msg);
        }

        return resp.data.context("playurl 响应无 data");
    }

    anyhow::bail!("WBI 签名重试后仍然失败")
}

/// 番剧 API 回退（用于番剧/影视类视频）
async fn try_bangumi_playurl(
    client: &Client,
    aid: u64,
    cid: i64,
    credential: &Credential,
) -> Result<SelectedStreams> {
    let mut last_error = String::new();

    for &qn in QUALITY_LEVELS {
        let params = vec![
            ("avid".to_string(), aid.to_string()),
            ("cid".to_string(), cid.to_string()),
            ("qn".to_string(), qn.to_string()),
            ("fnval".to_string(), "4048".to_string()),
            ("fourk".to_string(), "1".to_string()),
            ("otype".to_string(), "json".to_string()),
        ];

        let resp: PlayUrlResponse = client
            .get("https://api.bilibili.com/pgc/player/web/playurl")
            .headers(create_api_headers())
            .header("Cookie", credential.cookie_header())
            .query(&params)
            .send()
            .await?
            .json()
            .await?;

        if resp.code != 0 {
            last_error = resp.message.unwrap_or_else(|| "未知错误".to_string());
            continue;
        }

        // 番剧 API 用 result 而非 data
        let data = resp.result.or(resp.data).context("番剧 API 响应无数据")?;
        if let Some(streams) = parse_streams(&data) {
            return Ok(streams);
        }
    }

    anyhow::bail!("番剧 API 全部画质失败: {}", last_error)
}

// ==================== 流解析 ====================

/// 从 playurl 响应数据中解析音视频流（保留备用 URL）
fn parse_streams(data: &PlayUrlData) -> Option<SelectedStreams> {
    // 优先处理 DASH 格式
    if let Some(ref dash) = data.dash {
        if dash.video.is_empty() {
            return None;
        }

        // 选择最高质量的视频流（id 越大质量越高，优先非会员可用的 <=80）
        let video_stream = dash
            .video
            .iter()
            .filter(|s| s.id <= 80)
            .max_by_key(|s| s.id)
            .or_else(|| dash.video.first())?;

        let video_urls = build_url_list(&video_stream.base_url, &video_stream.backup_url);

        // 音频流：优先普通 > FLAC > Dolby
        let audio_urls = if let Some(audio) = dash.audio.iter().max_by_key(|s| s.id) {
            build_url_list(&audio.base_url, &audio.backup_url)
        } else if let Some(ref flac) = dash.flac {
            if let Some(ref audio) = flac.audio {
                build_url_list(&audio.base_url, &audio.backup_url)
            } else {
                Vec::new()
            }
        } else if let Some(ref dolby) = dash.dolby {
            if let Some(ref audio) = dolby.audio {
                build_url_list(&audio.base_url, &audio.backup_url)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        return Some(SelectedStreams {
            video_urls,
            audio_urls,
            is_legacy_format: false,
        });
    }

    // 回退处理旧格式（durl）
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

/// 构建主 URL + 备用 URL 列表，按 CDN 优先级排序（upos > cn > 其他）
fn build_url_list(primary: &str, backup: &Option<Vec<String>>) -> Vec<String> {
    let mut urls = vec![primary.to_string()];
    if let Some(ref backups) = backup {
        urls.extend(backups.iter().cloned());
    }
    // 按 CDN 域名优先级排序：upos > cn > mcdn > 其他
    urls.sort_by(|a, b| {
        let score = |url: &str| -> i32 {
            if url.contains("upos") {
                0
            } else if url.contains("cn-") {
                1
            } else if url.contains("mcdn") {
                3
            } else {
                2
            }
        };
        score(a).cmp(&score(b))
    });
    urls
}
