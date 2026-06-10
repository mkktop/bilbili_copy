use crate::bilibili::credential::Credential;
use anyhow::{Context, Result};
use md5::{Digest, Md5};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

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
    headers.insert("sec-ch-ua", HeaderValue::from_static(
        "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\""));
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert("sec-ch-ua-platform", HeaderValue::from_static("\"Windows\""));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    headers
}

/// WBI签名用的64位置换表
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
    29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30,
    4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// WBI密钥缓存（支持刷新，B站会定期轮换密钥）
static WBI_KEYS: RwLock<Option<WbiKeys>> = RwLock::new(None);

#[derive(Debug, Clone)]
pub struct WbiKeys {
    pub img_key: String,
    pub sub_key: String,
}

#[derive(Debug, Deserialize)]
struct NavResponse {
    code: i64,
    data: Option<NavData>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NavData {
    wbi_img: Option<WbiImg>,
}

#[derive(Debug, Deserialize)]
struct WbiImg {
    img_url: String,
    sub_url: String,
}

/// 从URL中提取文件名部分（去除路径和扩展名）
fn extract_key(url: &str) -> Option<&str> {
    let filename = url.rsplit('/').next()?;
    filename.rsplit_once('.').map(|(name, _)| name)
}

/// 从 img_key + sub_key 派生 mixin_key
fn get_mixin_key(img_key: &str, sub_key: &str) -> String {
    let combined = format!("{}{}", img_key, sub_key);
    let bytes = combined.as_bytes();
    MIXIN_KEY_ENC_TAB
        .iter()
        .take(32)
        .map(|&idx| bytes.get(idx).copied().unwrap_or(b'0') as char)
        .collect()
}

/// 对参数进行WBI签名
/// 参数格式: Vec<(&str, String)>
/// 返回: 添加了 wts 和 w_rid 的签名后参数
pub fn sign_params(params: &mut Vec<(String, String)>, mixin_key: &str) {
    // 移除不允许的字符
    let disallowed = ['!', '\'', '(', ')', '*'];
    for (_, v) in params.iter_mut() {
        for ch in disallowed {
            *v = v.replace(ch, "");
        }
    }

    // 添加时间戳
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    params.push(("wts".to_string(), timestamp.to_string()));

    // 按key排序
    params.sort_by(|a, b| a.0.cmp(&b.0));

    // 构建查询字符串并计算MD5
    let query: String = params
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                urlencoding::encode(k),
                urlencoding::encode(v).replace('+', "%20")
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    let mut hasher = Md5::new();
    hasher.update(query.as_bytes());
    hasher.update(mixin_key.as_bytes());
    let hash = hasher.finalize();
    let w_rid = format!("{:x}", hash);

    params.push(("w_rid".to_string(), w_rid));
}

/// 获取WBI签名密钥（带缓存）
async fn fetch_wbi_keys(credential: &Credential) -> Result<WbiKeys> {
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建HTTP客户端失败")?;

    let resp: NavResponse = client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .headers(create_api_headers())
        .header("Cookie", credential.cookie_header())
        .send()
        .await?
        .json()
        .await?;

    if resp.code != 0 {
        anyhow::bail!(
            "获取WBI密钥失败: {}",
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

    let data = resp.data.context("nav响应无data")?;
    let wbi_img = data.wbi_img.context("nav响应无wbi_img")?;

    let img_key = extract_key(&wbi_img.img_url).context("无法从img_url提取key")?;
    let sub_key = extract_key(&wbi_img.sub_url).context("无法从sub_url提取key")?;

    Ok(WbiKeys {
        img_key: img_key.to_string(),
        sub_key: sub_key.to_string(),
    })
}

/// 获取mixin_key用于签名（优先使用缓存）
pub async fn get_mixin_key_cached(credential: &Credential) -> Result<String> {
    // 先尝试读缓存
    {
        let guard = WBI_KEYS.read().unwrap();
        if let Some(keys) = guard.as_ref() {
            return Ok(get_mixin_key(&keys.img_key, &keys.sub_key));
        }
    }

    // 缓存为空，获取新的
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let mut guard = WBI_KEYS.write().unwrap();
        *guard = Some(keys);
    }
    Ok(mixin_key)
}

/// 强制刷新WBI密钥（签名失败时调用）
pub async fn refresh_mixin_key(credential: &Credential) -> Result<String> {
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let mut guard = WBI_KEYS.write().unwrap();
        *guard = Some(keys);
    }
    Ok(mixin_key)
}
