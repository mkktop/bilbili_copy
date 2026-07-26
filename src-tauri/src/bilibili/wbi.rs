use crate::bilibili::credential::Credential;
use crate::bilibili::USER_AGENT;
// header 构建已上提到 bilibili::create_api_headers，这里 re-export 保持 wbi::create_api_headers 调用点不变
pub use crate::bilibili::create_api_headers;
use anyhow::{Context, Result};
use md5::{Digest, Md5};
use reqwest::Client;
use serde::Deserialize;
use once_cell::sync::Lazy;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

/// WBI签名用的64位置换表
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
    29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30,
    4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// WBI 密钥缓存 TTL：B站每日轮换 img/sub key，缓存过期后必须重新获取。
/// 设为 12h 留出余量，避免在轮换时刻附近用到即将失效的 key。
const WBI_TTL: Duration = Duration::from_secs(12 * 3600);

/// 带获取时间戳的缓存条目：用于判断是否超过 TTL。
#[derive(Clone)]
struct CachedKeys {
    keys: WbiKeys,
    fetched_at: Instant,
}

/// WBI 密钥缓存（OnceLock 持有 RwLock<Option<CachedKeys>>）。
/// 读多写少：get_mixin_key_cached 走读锁快路径；过期/刷新走写锁。
static WBI_KEYS: OnceLock<RwLock<Option<CachedKeys>>> = OnceLock::new();

/// fetch 串行锁：缓存为空或过期时，多个并发请求只允许一个真正执行 nav 请求，
/// 其余在锁上等待并经 double-check 复用结果，避免冷启动/过期瞬间惊群打 nav。
static FETCH_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

fn wbi_keys_store() -> &'static RwLock<Option<CachedKeys>> {
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

/// 获取mixin_key用于签名（优先使用缓存）。
/// 缓存命中且未超过 WBI_TTL 时直接返回；否则经 fetch 锁串行获取一次（防惊群）。
pub async fn get_mixin_key_cached(credential: &Credential) -> Result<String> {
    // 1) 读锁快路径：命中且未过期直接返回（中毒时也恢复，避免 panic 永久拖垮签名）
    {
        let store = wbi_keys_store();
        let guard = store.read().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < WBI_TTL {
                return Ok(get_mixin_key(&c.keys.img_key, &c.keys.sub_key));
            }
        }
    }

    // 2) 缓存为空或过期：用 fetch 锁串行化，避免多个并发请求同时打 nav（惊群）
    let _fetch_guard = FETCH_LOCK.lock().await;

    // 3) 持锁后 double-check：可能在等锁期间已被其他任务刷新为有效 key
    {
        let store = wbi_keys_store();
        let guard = store.read().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < WBI_TTL {
                return Ok(get_mixin_key(&c.keys.img_key, &c.keys.sub_key));
            }
        }
    }

    // 4) 真正发起一次 nav 请求获取新 key 并写回缓存
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let store = wbi_keys_store();
        let mut guard = store.write().unwrap_or_else(|p| p.into_inner());
        *guard = Some(CachedKeys {
            keys,
            fetched_at: Instant::now(),
        });
    }
    Ok(mixin_key)
}

/// 强制刷新WBI密钥（签名失败时调用，如 playurl 收到 412/-404）
pub async fn refresh_mixin_key(credential: &Credential) -> Result<String> {
    let keys = fetch_wbi_keys(credential).await?;
    let mixin_key = get_mixin_key(&keys.img_key, &keys.sub_key);
    {
        let store = wbi_keys_store();
        let mut guard = store.write().unwrap_or_else(|p| p.into_inner());
        *guard = Some(CachedKeys {
            keys,
            fetched_at: Instant::now(),
        });
    }
    Ok(mixin_key)
}
