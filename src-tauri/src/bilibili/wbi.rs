use crate::bilibili::credential::Credential;
use crate::bilibili::{USER_AGENT, REFERER, ORIGIN};
use anyhow::{Context, Result};
use md5::{Digest, Md5};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// 构建模拟浏览器的 API 请求头
pub fn create_api_headers() -> HeaderMap {
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

/// WBI密钥缓存（使用 OnceLock 实现只获取一次，刷新时用 RwLock 覆盖）
static WBI_KEYS: OnceLock<RwLock<Option<WbiKeys>>> = OnceLock::new();

use std::sync::RwLock;

fn wbi_keys_store() -> &'static RwLock<Option<WbiKeys>> {
    WBI_KEYS.get_or_init(|| RwLock::new(None))
}

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

/// 对参数进行WBI签名（与 bili-sync-up 实现完全一致）
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

    // 使用 serde_urlencoded 构建查询字符串（与 bili-sync-up 一致）
    let query = serde_urlencoded::to_string(&params)
        .unwrap_or_default()
        .replace('+', "%20");

    // 计算 MD5(query + mixin_key)
    let mut hasher = Md5::new();
    hasher.update(query.as_bytes());
    hasher.update(mixin_key.as_bytes());
    let hash = hasher.finalize();
    let w_rid = format!("{:x}", hash);

    log::debug!("[wbi] 签名完成: wts={}, w_rid={}, query={}", params.iter().find(|(k,_)| k=="wts").map(|(_,v)| v.as_str()).unwrap_or(""), w_rid, &query[..query.len().min(200)]);
    params.push(("w_rid".to_string(), w_rid));
}

/// 获取WBI签名密钥（带缓存）
async fn fetch_wbi_keys(credential: &Credential) -> Result<WbiKeys> {
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .timeout(crate::bilibili::API_TIMEOUT)
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
            "获取WBI密钥失败: code={}, msg={}",
            resp.code,
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

    let data = resp.data.context("nav响应无data")?;
    let wbi_img = data.wbi_img.context("nav响应无wbi_img")?;

    let img_key = extract_key(&wbi_img.img_url).context("无法从img_url提取key")?;
    let sub_key = extract_key(&wbi_img.sub_url).context("无法从sub_url提取key")?;

    log::info!("[wbi] 获取WBI密钥: img_key={}, sub_key={}", img_key, sub_key);
    Ok(WbiKeys {
        img_key: img_key.to_string(),
        sub_key: sub_key.to_string(),
    })
}

/// 获取mixin_key用于签名（优先使用缓存）
pub async fn get_mixin_key_cached(credential: &Credential) -> Result<String> {
    let store = wbi_keys_store();
    // 先尝试读缓存（中毒时也恢复，避免一次 panic 永久拖垮所有 WBI 签名）
    {
        let guard = store.read().unwrap_or_else(|p| p.into_inner());
        if let Some(keys) = guard.as_ref() {
            return Ok(get_mixin_key(&keys.img_key, &keys.sub_key));
        }
    }

    // 缓存为空，获取新的（使用 double-check 避免重复获取）
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let mut guard = store.write().unwrap_or_else(|p| p.into_inner());
        // double-check: 如果其他任务已经写入了，使用已有的
        if guard.is_none() {
            *guard = Some(keys);
        } else if let Some(existing) = guard.as_ref() {
            return Ok(get_mixin_key(&existing.img_key, &existing.sub_key));
        }
    }
    Ok(mixin_key)
}

/// 强制刷新WBI密钥（签名失败时调用）
pub async fn refresh_mixin_key(credential: &Credential) -> Result<String> {
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let store = wbi_keys_store();
        let mut guard = store.write().unwrap_or_else(|p| p.into_inner());
        *guard = Some(keys);
    }
    Ok(mixin_key)
}
