pub mod video;
pub mod credential;
pub mod passport;
pub mod url;
pub mod wbi;
pub mod playurl;
pub mod download;
pub mod risk_control;
pub mod favorite;
pub mod fingerprint;
pub mod danmaku;
pub mod subtitle;
pub mod watch_later;
pub mod search;
pub mod submission;
pub mod collection;
pub mod following;
pub mod nfo;
pub mod history;
pub mod ranking;
pub mod pgc;
pub mod recommend;
pub mod region;
pub mod comment;
pub mod dynamic;
pub mod interaction;
pub mod throttle;
pub mod mp4_seek;
pub mod filename;

// ==================== 共享常量 ====================

use std::time::Duration;

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
pub const REFERER: &str = "https://www.bilibili.com/";
pub const ORIGIN: &str = "https://www.bilibili.com";

/// B站 API 请求总超时（覆盖所有非流式 API 调用，避免单次挂起的连接永久阻塞任务）
pub const API_TIMEOUT: Duration = Duration::from_secs(15);

// ==================== 共享类型 ====================

use serde::{Deserialize, Serialize};

/// B站 API 通用响应结构
#[derive(Debug, Deserialize)]
pub struct BilibiliResponse<T> {
    pub code: i64,
    pub data: Option<T>,
    pub message: Option<String>,
}

/// 通用视频列表项：稍后再看 / UP主投稿 / 合集 共用，前端可复用同一套卡片
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoListItem {
    pub bvid: String,
    pub title: String,
    pub cover: String,
    #[serde(default)]
    pub upper_name: String,
    #[serde(default)]
    pub upper_mid: i64,
    /// 时长（秒）
    #[serde(default)]
    pub duration: i64,
    #[serde(default)]
    pub play: i64,
    #[serde(default)]
    pub danmaku: i64,
    /// 发布时间（unix 秒），0 表示未知
    #[serde(default)]
    pub pubdate: i64,
}

/// 通用分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagedResult<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub has_more: bool,
    pub page: u32,
}

// ==================== 共享工具函数 ====================

/// 将 http:// URL 替换为 https://，避免混合内容被 WebView 拦截
pub fn http_to_https(url: &str) -> String {
    if url.starts_with("http://") {
        url.replacen("http://", "https://", 1)
    } else {
        url.to_string()
    }
}

/// 创建带超时的通用 B站 API 客户端（不启用 cookie jar）。
/// 所有短小的 API 调用都应使用此客户端，避免某个挂起的连接永久阻塞异步任务。
pub fn api_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .timeout(API_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 构建模拟浏览器的 API 请求头（UA / Referer / Origin / sec-ch-* 全套）。
/// wbi / playurl / subtitle 等需要完整浏览器指纹的调用共用此函数，
/// B站改 header 要求时只需改这一处。
pub fn create_api_headers() -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
    headers.insert("Accept", HeaderValue::from_static("*/*"));
    headers.insert("Accept-Language", HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
    headers.insert("Referer", HeaderValue::from_static(REFERER));
    headers.insert("Origin", HeaderValue::from_static(ORIGIN));
    headers.insert("sec-ch-ua", HeaderValue::from_static(
        "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\""));
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert("sec-ch-ua-platform", HeaderValue::from_static("\"Windows\""));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    headers
}
