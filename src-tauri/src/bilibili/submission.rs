use crate::bilibili::credential::Credential;
use crate::bilibili::wbi;
use crate::bilibili::{REFERER, USER_AGENT, PagedResult, VideoListItem, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// UP 主基本信息（web-interface/card）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpperInfo {
    pub mid: i64,
    pub name: String,
    pub face: String,
    #[serde(default)]
    pub sign: String,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub fans: i64,
    #[serde(default)]
    pub following: i64,
    #[serde(default)]
    pub archive_count: i64,
}

fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 获取 UP 主卡片信息（头像/名字/签名/粉丝数/投稿数）
/// API: GET https://api.bilibili.com/x/web-interface/card?mid=
pub async fn get_upper_info(mid: i64, credential: Option<&Credential>) -> Result<UpperInfo> {
    let client = bilibili_client()?;
    let mut request = client
        .get("https://api.bilibili.com/x/web-interface/card")
        .header("Referer", REFERER)
        .query(&[("mid", mid.to_string().as_str())]);
    if let Some(cred) = credential {
        request = request.header("Cookie", cred.cookie_header());
    }

    let resp_text = request.send().await?.text().await?;
    log::debug!(
        "[submission] card 响应: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value = serde_json::from_str(&resp_text).context("UP 主卡片响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取 UP 主信息失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let card = &resp["data"]["card"];
    Ok(UpperInfo {
        mid: card["mid"].as_i64().unwrap_or(mid),
        name: card["name"].as_str().unwrap_or("未知用户").to_string(),
        face: http_to_https(card["face"].as_str().unwrap_or("")),
        sign: card["sign"].as_str().unwrap_or("").to_string(),
        level: card["level_info"]["current_level"]
            .as_i64()
            .unwrap_or(0) as u32,
        fans: card["fans"].as_i64().unwrap_or(0),
        following: card["attention"].as_i64().unwrap_or(0),
        // B站 web-interface/card 的 archive_count 在 data 顶层（非 card 内）；历史误读 card.archive_count 导致恒为 0
        archive_count: resp["data"]["archive_count"].as_i64().unwrap_or(0),
    })
}

/// 获取 UP 主投稿视频列表（分页，按发布时间倒序）
/// API: GET https://api.bilibili.com/x/space/wbi/arc/search （WBI 签名）
pub async fn get_submission_videos(
    mid: i64,
    page: u32,
    keyword: Option<&str>,
    credential: &Credential,
) -> Result<PagedResult<VideoListItem>> {
    let client = bilibili_client()?;
    let mixin_key = wbi::get_mixin_key_cached(credential)
        .await
        .context("获取 WBI 签名密钥失败")?;

    let mut params: Vec<(String, String)> = vec![
        ("mid".to_string(), mid.to_string()),
        ("pn".to_string(), page.to_string()),
        ("ps".to_string(), "30".to_string()),
        ("order".to_string(), "pubdate".to_string()),
        ("order_avoided".to_string(), "true".to_string()),
        ("platform".to_string(), "web".to_string()),
        ("web_location".to_string(), "1550101".to_string()),
    ];
    if let Some(kw) = keyword {
        if !kw.trim().is_empty() {
            params.push(("keyword".to_string(), kw.to_string()));
        }
    }
    wbi::sign_params(&mut params, &mixin_key);

    let resp_text = client
        .get("https://api.bilibili.com/x/space/wbi/arc/search")
        .header("Referer", format!("https://space.bilibili.com/{}", mid))
        .header("Cookie", credential.cookie_header())
        .query(&params)
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[submission] arc/search 响应: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value = serde_json::from_str(&resp_text).context("投稿列表响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取投稿列表失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["page"]["count"].as_i64().unwrap_or(0);
    let vlist = resp["data"]["list"]["vlist"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<VideoListItem> = vlist
        .into_iter()
        .map(|v| VideoListItem {
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: String::new(),
            upper_mid: mid,
            duration: parse_length(v["length"].as_str().unwrap_or("0:0")),
            play: v["play"].as_i64().unwrap_or(0),
            danmaku: v["video_review"].as_i64().unwrap_or(0),
            pubdate: v["created"].as_i64().unwrap_or(0),
        })
        .collect();

    let page_size = 30i64;
    let has_more = total > (page as i64) * page_size;

    log::info!(
        "[submission] UP {} 第 {} 页投稿: {} 个, total={}, has_more={}",
        mid,
        page,
        items.len(),
        total,
        has_more
    );

    Ok(PagedResult {
        items,
        total,
        has_more,
        page,
    })
}

/// 将 "mm:ss" 或 "hh:mm:ss" 转为秒
fn parse_length(s: &str) -> i64 {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let m = parts[0].parse::<i64>().unwrap_or(0);
            let sec = parts[1].parse::<i64>().unwrap_or(0);
            m * 60 + sec
        }
        3 => {
            let h = parts[0].parse::<i64>().unwrap_or(0);
            let m = parts[1].parse::<i64>().unwrap_or(0);
            let sec = parts[2].parse::<i64>().unwrap_or(0);
            h * 3600 + m * 60 + sec
        }
        _ => 0,
    }
}
