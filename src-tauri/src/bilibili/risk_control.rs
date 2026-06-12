use crate::bilibili::{REFERER, USER_AGENT};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::time::Instant;

/// gaia_vtoken 内存缓存（1 小时 TTL）
static GAIA_VTOKEN: Lazy<Mutex<Option<(String, Instant)>>> =
    Lazy::new(|| Mutex::new(None));

const GAIA_VTOKEN_TTL_SECS: u64 = 3600; // 1 小时

/// 获取缓存的 gaia_vtoken（未过期返回 Some）
pub fn get_gaia_vtoken() -> Option<String> {
    let guard = GAIA_VTOKEN.lock().unwrap();
    guard
        .as_ref()
        .filter(|(_, created)| created.elapsed().as_secs() < GAIA_VTOKEN_TTL_SECS)
        .map(|(token, _)| token.clone())
}

/// 保存 gaia_vtoken 到缓存
pub fn set_gaia_vtoken(token: String) {
    let mut guard = GAIA_VTOKEN.lock().unwrap();
    *guard = Some((token, Instant::now()));
}

/// 验证码注册信息（传给前端用于渲染 GeeTest）
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptchaInfo {
    pub token: String,
    pub gt: String,
    pub challenge: String,
}

/// 注册风控验证码
/// POST https://api.bilibili.com/x/gaia-vgate/v1/register
pub async fn register_captcha(v_voucher: &str, csrf: &str) -> Result<CaptchaInfo> {
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post("https://api.bilibili.com/x/gaia-vgate/v1/register")
        .header("User-Agent", USER_AGENT)
        .header("Referer", REFERER)
        .form(&[
            ("v_voucher", v_voucher),
            ("csrf", csrf),
        ])
        .send()
        .await?
        .json()
        .await?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "验证码注册失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let data = resp.get("data").context("验证码注册响应无 data")?;
    Ok(CaptchaInfo {
        token: data["token"].as_str().unwrap_or("").to_string(),
        gt: data["geetest"]["gt"].as_str().unwrap_or("").to_string(),
        challenge: data["geetest"]["challenge"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    })
}

/// 提交验证码验证结果，获取 gaia_vtoken
/// POST https://api.bilibili.com/x/gaia-vgate/v1/validate
pub async fn validate_captcha(
    challenge: &str,
    token: &str,
    validate: &str,
    seccode: &str,
    csrf: &str,
) -> Result<String> {
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post("https://api.bilibili.com/x/gaia-vgate/v1/validate")
        .header("User-Agent", USER_AGENT)
        .header("Referer", REFERER)
        .form(&[
            ("challenge", challenge),
            ("token", token),
            ("validate", validate),
            ("seccode", seccode),
            ("csrf", csrf),
        ])
        .send()
        .await?
        .json()
        .await?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "验证码验证失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let is_valid = resp["data"]["is_valid"].as_i64().unwrap_or(0);
    if is_valid != 1 {
        anyhow::bail!("验证码验证未通过");
    }

    let gaia_vtoken = resp["data"]["grisk_id"]
        .as_str()
        .context("验证响应缺少 grisk_id")?
        .to_string();

    // 缓存 token
    set_gaia_vtoken(gaia_vtoken.clone());
    log::info!("[risk_control] 验证码验证成功，gaia_vtoken 已缓存");

    Ok(gaia_vtoken)
}
