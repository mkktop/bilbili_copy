use crate::bilibili::credential::Credential;
use crate::bilibili::wbi;
use crate::bilibili::{USER_AGENT, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 搜索结果项（视频 / UP主 / 番剧 / 影视通用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// video | bili_user | media_bangumi | media_ft
    #[serde(rename = "type")]
    pub result_type: String,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bvid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    pub cover: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubdate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danmaku: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower: Option<i64>,
}

/// 搜索结果分页包装
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultList {
    pub results: Vec<SearchResult>,
    pub total: u32,
    pub num_pages: u32,
    pub page: u32,
}

fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 搜索 B站内容
/// 优先用旧接口 `/x/web-interface/search/type`，触发风控(412)或失败时回退 WBI 签名接口
/// API: GET https://api.bilibili.com/x/web-interface/search/type
///      GET https://api.bilibili.com/x/web-interface/wbi/search/type
pub async fn search(
    keyword: &str,
    search_type: &str,
    page: u32,
    credential: &Credential,
) -> Result<SearchResultList> {
    match search_via_legacy(keyword, search_type, page, credential).await {
        Ok(res) => Ok(res),
        Err(err) => {
            log::warn!("[search] 旧搜索接口失败，回退 WBI 接口: {}", err);
            search_via_wbi(keyword, search_type, page, credential).await
        }
    }
}

/// 旧搜索接口（无需 WBI 签名）
async fn search_via_legacy(
    keyword: &str,
    search_type: &str,
    page: u32,
    credential: &Credential,
) -> Result<SearchResultList> {
    let client = bilibili_client()?;
    let resp_text = client
        .get("https://api.bilibili.com/x/web-interface/search/type")
        .header("Referer", "https://search.bilibili.com/")
        .header("Cookie", credential.cookie_header())
        .query(&[
            ("keyword", keyword),
            ("search_type", search_type),
            ("page", &page.to_string()),
            ("page_size", "20"),
            ("order", "totalrank"),
            ("duration", "0"),
            ("tids", "0"),
        ])
        .send()
        .await?
        .text()
        .await?;

    parse_search_response(&resp_text, search_type, page)
}

/// WBI 签名搜索接口
async fn search_via_wbi(
    keyword: &str,
    search_type: &str,
    page: u32,
    credential: &Credential,
) -> Result<SearchResultList> {
    let client = bilibili_client()?;
    let mixin_key = wbi::get_mixin_key_cached(credential)
        .await
        .context("获取 WBI 签名密钥失败")?;

    let mut params: Vec<(String, String)> = vec![
        ("keyword".to_string(), keyword.to_string()),
        ("search_type".to_string(), search_type.to_string()),
        ("page".to_string(), page.to_string()),
        ("page_size".to_string(), "20".to_string()),
        ("order".to_string(), "totalrank".to_string()),
        ("duration".to_string(), "0".to_string()),
        ("platform".to_string(), "pc".to_string()),
        ("highlight".to_string(), "1".to_string()),
        ("single_column".to_string(), "0".to_string()),
    ];
    wbi::sign_params(&mut params, &mixin_key);

    let resp_text = client
        .get("https://api.bilibili.com/x/web-interface/wbi/search/type")
        .header("Referer", "https://search.bilibili.com/")
        .header("Cookie", credential.cookie_header())
        .query(&params)
        .send()
        .await?
        .text()
        .await?;

    parse_search_response(&resp_text, search_type, page)
}

/// 解析搜索响应（旧接口和 WBI 接口结构一致）
fn parse_search_response(resp_text: &str, search_type: &str, page: u32) -> Result<SearchResultList> {
    let resp: Value = serde_json::from_str(resp_text).context("搜索响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "搜索失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let data = &resp["data"];
    let total = data["numResults"].as_u64().unwrap_or(0) as u32;
    let mut num_pages = data["numPages"].as_u64().unwrap_or(0) as u32;
    if num_pages == 0 {
        num_pages = if total > 0 { total.div_ceil(20) } else { 1 };
    }

    let results = data["result"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| parse_search_item(&item, search_type))
        .collect::<Vec<_>>();

    log::info!(
        "[search] keyword 搜索 {} 类型第 {} 页: {} 条结果, 总数 {}",
        search_type,
        page,
        results.len(),
        total
    );

    Ok(SearchResultList {
        results,
        total,
        num_pages,
        page,
    })
}

/// 按 search_type 解析单个搜索结果
fn parse_search_item(item: &Value, search_type: &str) -> Option<SearchResult> {
    // 搜索结果标题里会带 <em class="keyword">高亮</em>，统一去除标签
    let clean_title = |v: &Value| -> String {
        v.as_str()
            .unwrap_or("")
            .replace("<em class=\"keyword\">", "")
            .replace("</em>", "")
    };

    let to_str = |v: &Value| -> Option<String> {
        v.as_str().map(|s| s.to_string())
    };
    let to_num_str = |v: &Value| -> Option<String> {
        v.as_str()
            .map(|s| s.to_string())
            .or_else(|| v.as_i64().map(|n| n.to_string()))
    };

    match search_type {
        "video" => Some(SearchResult {
            result_type: "video".into(),
            title: clean_title(&item["title"]),
            author: item["author"].as_str().unwrap_or("").to_string(),
            bvid: to_str(&item["bvid"]),
            aid: item["aid"].as_i64(),
            mid: item["mid"].as_i64(),
            season_id: None,
            media_id: None,
            cover: http_to_https(item["pic"].as_str().unwrap_or("")),
            description: item["description"].as_str().unwrap_or("").to_string(),
            duration: to_str(&item["duration"]),
            pubdate: item["pubdate"].as_i64(),
            play: item["play"].as_i64(),
            danmaku: item["video_review"].as_i64(),
            follower: None,
        }),
        "bili_user" => Some(SearchResult {
            result_type: "bili_user".into(),
            title: item["uname"].as_str().unwrap_or("").to_string(),
            author: item["uname"].as_str().unwrap_or("").to_string(),
            bvid: None,
            aid: None,
            mid: item["mid"].as_i64(),
            season_id: None,
            media_id: None,
            cover: http_to_https(item["upic"].as_str().unwrap_or("")),
            description: item["usign"].as_str().unwrap_or("").to_string(),
            duration: None,
            pubdate: None,
            play: None,
            danmaku: None,
            follower: item["fans"].as_i64(),
        }),
        "media_bangumi" | "media_ft" => Some(SearchResult {
            result_type: search_type.to_string(),
            title: clean_title(&item["title"]),
            author: item["staff"].as_str().unwrap_or("").to_string(),
            bvid: None,
            aid: None,
            mid: None,
            season_id: to_num_str(&item["season_id"]),
            media_id: to_num_str(&item["media_id"]),
            cover: http_to_https(item["cover"].as_str().unwrap_or("")),
            description: item["desc"].as_str().unwrap_or("").to_string(),
            duration: None,
            pubdate: None,
            play: None,
            danmaku: None,
            follower: None,
        }),
        _ => None,
    }
}
