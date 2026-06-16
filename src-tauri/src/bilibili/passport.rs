use crate::bilibili::credential::{Credential, UserInfo};
use crate::bilibili::{USER_AGENT, REFERER, ORIGIN, BilibiliResponse, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct QrGenerateData {
    pub url: String,
    pub qrcode_key: String,
}

#[derive(Debug, Deserialize)]
pub struct QrPollData {
    pub code: i64,
    pub refresh_token: Option<String>,
}

/// 创建启用 cookie jar 的 reqwest Client（用于一般请求，自动管理 cookies）
fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 创建不启用 cookie jar 的 Client（用于 poll 请求，需要手动读取 Set-Cookie）
fn raw_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 访问B站首页，预热 buvid3 cookie
pub async fn seed_buvid() -> Result<()> {
    let client = bilibili_client()?;
    client
        .get("https://www.bilibili.com")
        .header("Referer", REFERER)
        .header("Origin", ORIGIN)
        .send()
        .await?;
    Ok(())
}

/// 生成二维码
pub async fn generate_qrcode() -> Result<QrGenerateData> {
    let client = bilibili_client()?;
    let resp: BilibiliResponse<QrGenerateData> = client
        .get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        .header("Referer", REFERER)
        .header("Origin", ORIGIN)
        .send()
        .await?
        .json()
        .await?;

    if resp.code != 0 {
        anyhow::bail!("二维码生成失败: {:?}", resp.message);
    }
    resp.data.context("二维码响应无 data")
}

/// 轮询二维码状态
/// 返回 (状态码, 可能的 Credential)
/// 86101=未扫描, 86090=已扫描待确认, 0=登录成功, 86038=已过期
pub async fn poll_qrcode(qrcode_key: &str) -> Result<(i64, Option<Credential>)> {
    let client = raw_client()?;
    let resp = client
        .get(format!(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={}",
            qrcode_key
        ))
        .header("Referer", REFERER)
        .header("Origin", ORIGIN)
        .send()
        .await?;

    // 提取 Set-Cookie 头
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(String::from))
        .collect();

    let body: BilibiliResponse<QrPollData> = resp.json().await?;
    let code = body.data.as_ref().map(|d| d.code).unwrap_or(body.code);

    if code == 0 {
        let refresh_token = body
            .data
            .and_then(|d| d.refresh_token)
            .unwrap_or_default();
        let mut cred = extract_cookies(&set_cookies)?;
        cred.ac_time_value = refresh_token;

        // buvid3/buvid4 缺失时回退 SPI
        if cred.buvid3.is_empty() || cred.buvid4.is_none() {
            if let Ok((b3, b4)) = fetch_buvid().await {
                if cred.buvid3.is_empty() {
                    cred.buvid3 = b3;
                }
                if cred.buvid4.is_none() {
                    cred.buvid4 = Some(b4);
                }
            }
        }
        return Ok((0, Some(cred)));
    }

    Ok((code, None))
}

/// 回退获取 buvid3/buvid4
pub async fn fetch_buvid() -> Result<(String, String)> {
    let client = bilibili_client()?;
    #[derive(Deserialize)]
    struct SpiData {
        b_3: String,
        b_4: String,
    }
    let resp: BilibiliResponse<SpiData> = client
        .get("https://api.bilibili.com/x/frontend/finger/spi")
        .header("Referer", REFERER)
        .send()
        .await?
        .json()
        .await?;

    let data = resp.data.context("SPI 响应无 data")?;
    Ok((data.b_3, data.b_4))
}

/// 获取用户的关注数和粉丝数
async fn get_relation_info(client: &Client, cred: &Credential, mid: u64) -> Result<(u64, u64)> {
    #[derive(Deserialize)]
    struct RelationData {
        #[serde(default)]
        following: u64,
        #[serde(default)]
        follower: u64,
    }
    let resp: BilibiliResponse<RelationData> = client
        .get("https://api.bilibili.com/x/relation/stat")
        .header("Cookie", cred.cookie_header())
        .header("Referer", REFERER)
        .query(&[("vmid", mid.to_string())])
        .send()
        .await?
        .json()
        .await?;

    if let Some(data) = resp.data {
        Ok((data.following, data.follower))
    } else {
        Ok((0, 0))
    }
}

/// 获取登录用户的硬币余额
/// B站 nav 的 coins 字段不可靠（对多数账号恒为 0），改用专用接口。
/// API: GET https://account.bilibili.com/site/getCoin → data.money
async fn get_coin_count(client: &Client, cred: &Credential) -> Result<f64> {
    #[derive(Deserialize)]
    struct CoinData {
        #[serde(default)]
        money: f64,
    }
    let resp: BilibiliResponse<CoinData> = client
        .get("https://account.bilibili.com/site/getCoin")
        .header("Cookie", cred.cookie_header())
        .header("Referer", REFERER)
        .send()
        .await?
        .json()
        .await?;

    let data = resp.data.context("getCoin 响应无 data")?;
    Ok(data.money)
}

/// 验证凭证是否有效，返回用户信息
pub async fn validate_credentials(cred: &Credential) -> Result<UserInfo> {
    let client = bilibili_client()?;
    #[derive(Deserialize)]
    struct LevelInfo {
        // B站 nav 返回等级在 level_info.current_level；历史误用 level 字段名导致恒为 0
        #[serde(default)]
        current_level: u8,
    }
    #[derive(Deserialize)]
    struct VipInfo {
        #[serde(default)]
        status: u8,
    }
    #[derive(Deserialize)]
    struct NavData {
        mid: u64,
        uname: String,
        face: String,
        #[serde(default)]
        level_info: Option<LevelInfo>,
        #[serde(default)]
        sign: String,
        #[serde(default)]
        vip: Option<VipInfo>,
        #[serde(default)]
        sex: String,
    }
    // dedeuserid 即用户 mid，用作 relation 请求参数，使 nav 与 relation 两个独立请求
    // 并发执行（省一次串行往返）。relation 为 best-effort：失败或无 mid 时返回 (0,0)，
    // 不影响登录校验主流程。
    let mid_from_cred: u64 = cred.dedeuserid.parse().unwrap_or(0);

    let (nav_result, relation, coins) = tokio::join!(
        async {
            let resp: BilibiliResponse<NavData> = client
                .get("https://api.bilibili.com/x/web-interface/nav")
                .header("Cookie", cred.cookie_header())
                .header("Referer", REFERER)
                .send()
                .await?
                .json()
                .await?;
            Result::<_, anyhow::Error>::Ok(resp)
        },
        async {
            if mid_from_cred == 0 {
                return (0u64, 0u64);
            }
            match get_relation_info(&client, cred, mid_from_cred).await {
                Ok(info) => info,
                Err(e) => {
                    log::warn!("[passport] 获取关注/粉丝数失败: {}", e);
                    (0u64, 0u64)
                }
            }
        },
        async {
            // nav 的 coins 不可靠，硬币余额走专用 getCoin 接口（best-effort，失败回退 0）
            match get_coin_count(&client, cred).await {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[passport] 获取硬币余额失败: {}", e);
                    0.0
                }
            }
        },
    );

    let resp = nav_result?;
    if resp.code != 0 {
        anyhow::bail!("凭证验证失败: {:?}", resp.message);
    }
    let data = resp.data.context("nav 响应无 data")?;

    let (following, follower) = relation;

    Ok(UserInfo {
        mid: data.mid,
        uname: data.uname,
        face: http_to_https(&data.face),
        level: data.level_info.map(|l| l.current_level).unwrap_or(0),
        coins,
        sign: data.sign,
        vip: data.vip.map(|v| v.status == 1).unwrap_or(false),
        following,
        follower,
        sex: data.sex,
    })
}

/// 从 Set-Cookie 头解析凭证
fn extract_cookies(set_cookies: &[String]) -> Result<Credential> {
    let mut cookies = std::collections::HashMap::new();
    for raw in set_cookies {
        if let Some(pair) = raw.split(';').next() {
            let pair = pair.trim();
            if let Some((k, v)) = pair.split_once('=') {
                cookies.insert(k.to_string(), v.to_string());
            }
        }
    }
    Ok(Credential {
        sessdata: cookies
            .get("SESSDATA")
            .cloned()
            .context("缺少 SESSDATA cookie")?,
        bili_jct: cookies
            .get("bili_jct")
            .cloned()
            .context("缺少 bili_jct cookie")?,
        dedeuserid: cookies
            .get("DedeUserID")
            .cloned()
            .context("缺少 DedeUserID cookie")?,
        buvid3: cookies.get("buvid3").cloned().unwrap_or_default(),
        buvid4: cookies.get("buvid4").cloned(),
        dedeuserid_ckmd5: cookies.get("DedeUserID__ckMd5").cloned(),
        ac_time_value: String::new(),
    })
}
