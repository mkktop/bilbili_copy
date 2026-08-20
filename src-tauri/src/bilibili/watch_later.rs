use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, VideoListItem, api_client, http_to_https};
use anyhow::{Context, Result};
use serde_json::Value;

/// 获取当前用户的稍后再看列表
/// API: GET https://api.bilibili.com/x/v2/history/toview
pub async fn get_watch_later(credential: &Credential) -> Result<Vec<VideoListItem>> {
    let client = api_client();

    let resp_text = client
        .get("https://api.bilibili.com/x/v2/history/toview")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[watch_later] toview 响应: {}",
        resp_text.chars().take(500).collect::<String>()
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("稍后再看响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取稍后再看失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<VideoListItem> = list
        .into_iter()
        .map(|v| VideoListItem {
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            title: v["title"].as_str().unwrap_or("(已失效视频)").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
            upper_mid: v["owner"]["mid"].as_i64().unwrap_or(0),
            duration: v["duration"].as_i64().unwrap_or(0),
            play: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
            pubdate: v["pubdate"].as_i64().unwrap_or(0),
        })
        .collect();

    log::info!("[watch_later] 获取到 {} 个稍后再看视频", items.len());
    Ok(items)
}
