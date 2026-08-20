use crate::bilibili::credential::Credential;
use crate::bilibili::{PagedResult, REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 关注的 UP 主信息（/x/relation/followings）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowingItem {
    pub mid: i64,
    pub name: String,
    pub face: String,
    #[serde(default)]
    pub sign: String,
}

/// 获取当前登录用户的关注列表（分页）
/// API: GET https://api.bilibili.com/x/relation/followings?vmid=&pn=&ps=
/// 鉴权：cookie（无需 WBI 签名）
pub async fn get_followings(page: u32, credential: &Credential) -> Result<PagedResult<FollowingItem>> {
    let client = api_client();
    let vmid = &credential.dedeuserid;

    let resp_text = client
        .get("https://api.bilibili.com/x/relation/followings")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&[
            ("vmid", vmid.as_str()),
            ("pn", &page.to_string()),
            ("ps", "50"),
        ])
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[following] followings 响应: {}",
        resp_text.chars().take(500).collect::<String>()
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("关注列表响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取关注列表失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["total"].as_i64().unwrap_or(0);
    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<FollowingItem> = list
        .into_iter()
        .map(|v| FollowingItem {
            mid: v["mid"].as_i64().unwrap_or(0),
            name: v["uname"].as_str().unwrap_or("未知用户").to_string(),
            face: http_to_https(v["face"].as_str().unwrap_or("")),
            sign: v["sign"].as_str().unwrap_or("").to_string(),
        })
        .collect();

    let page_size = 50i64;
    let has_more = total > (page as i64) * page_size;

    log::info!(
        "[following] 第 {} 页关注: {} 个, total={}, has_more={}",
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

/// 获取某用户的粉丝列表（分页，公开接口）
/// API: GET https://api.bilibili.com/x/relation/followers?vmid=&pn=&ps=
/// 与关注列表结构一致，用于 UP 主主页的「粉丝」tab。
pub async fn get_followers(
    mid: i64,
    page: u32,
    credential: &Credential,
) -> Result<PagedResult<FollowingItem>> {
    let client = api_client();

    let resp_text = client
        .get("https://api.bilibili.com/x/relation/followers")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&[
            ("vmid", mid.to_string().as_str()),
            ("pn", page.to_string().as_str()),
            ("ps", "50"),
        ])
        .send()
        .await?
        .text()
        .await?;

    let resp: Value =
        serde_json::from_str(&resp_text).context("粉丝列表响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取粉丝列表失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["total"].as_i64().unwrap_or(0);
    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<FollowingItem> = list
        .into_iter()
        .map(|v| FollowingItem {
            mid: v["mid"].as_i64().unwrap_or(0),
            name: v["uname"].as_str().unwrap_or("未知用户").to_string(),
            face: http_to_https(v["face"].as_str().unwrap_or("")),
            sign: v["sign"].as_str().unwrap_or("").to_string(),
        })
        .collect();

    let page_size = 50i64;
    let has_more = total > (page as i64) * page_size;

    log::info!(
        "[following] mid={} 第 {} 页粉丝: {} 个, total={}",
        mid,
        page,
        items.len(),
        total
    );

    Ok(PagedResult {
        items,
        total,
        has_more,
        page,
    })
}
