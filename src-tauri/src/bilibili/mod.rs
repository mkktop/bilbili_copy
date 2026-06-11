pub mod client;
pub mod video;
pub mod credential;
pub mod passport;
pub mod url;
pub mod wbi;
pub mod playurl;
pub mod download;

// ==================== 共享常量 ====================

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
pub const REFERER: &str = "https://www.bilibili.com/";
pub const ORIGIN: &str = "https://www.bilibili.com";

// ==================== 共享类型 ====================

use serde::Deserialize;

/// B站 API 通用响应结构
#[derive(Debug, Deserialize)]
pub struct BilibiliResponse<T> {
    pub code: i64,
    pub data: Option<T>,
    pub message: Option<String>,
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
