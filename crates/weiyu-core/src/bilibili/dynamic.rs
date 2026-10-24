use crate::bilibili::credential::Credential;
use crate::bilibili::{api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 关注动态视频条目（web-dynamic feed/all，type=video 过滤后每条对应一个视频投稿）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicItem {
    pub bvid: String,
    pub title: String,
    pub cover: String,
    pub upper_name: String,
    pub upper_mid: i64,
    pub upper_face: String,
    /// 发布时间（unix 秒）
    #[serde(default)]
    pub pub_ts: i64,
    /// 动态动作文案（如「投稿了视频」）
    #[serde(default)]
    pub pub_action: String,
    /// 播放量展示文本（接口返回字符串，如「10.2万」）
    #[serde(default)]
    pub play_text: String,
    /// 弹幕数展示文本
    #[serde(default)]
    pub danmaku_text: String,
    /// 时长展示文本（如「12:34」）
    #[serde(default)]
    pub duration_text: String,
}

/// 动态流分页结果（cursor 分页：下一页把 offset 原样传回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicFeedResult {
    pub items: Vec<DynamicItem>,
    pub offset: String,
    pub has_more: bool,
}

/// 获取关注动态视频流
/// API: GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all
///   type=video：只取视频投稿动态（转发/图文/直播动态不在本页范围）
///   offset：cursor 分页游标，首页传空，下一页用上次响应的 data.offset
///
/// 需登录态（带 cookie），未登录返回错误由前端展示登录提示。
/// 视频信息在 item.modules.module_dynamic.major.archive，
/// 作者信息在 item.modules.module_author。
pub async fn get_dynamic_feed(offset: &str, credential: &Credential) -> Result<DynamicFeedResult> {
    let client = api_client();

    let mut query: Vec<(&str, &str)> = vec![
        ("timezone_offset", "-480"),
        ("type", "video"),
        ("platform", "web"),
        ("features", "itemOpusStyle"),
    ];
    if !offset.is_empty() {
        query.push(("offset", offset));
    }

    let resp_text = client
        .get("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all")
        // 动态流的 Referer 是动态站点域名（与主站 REFERER 不同）
        .header("Referer", "https://t.bilibili.com/")
        .header("Cookie", credential.cookie_header())
        .query(&query)
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[dynamic] offset={:?} 响应前 500 字: {}",
        offset,
        resp_text.chars().take(500).collect::<String>()
    );

    let resp: Value = serde_json::from_str(&resp_text).context("动态流响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取动态失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let data = &resp["data"];
    let raw_items = data["items"].as_array().cloned().unwrap_or_default();

    let items: Vec<DynamicItem> = raw_items
        .into_iter()
        .filter_map(|v| {
            let author = &v["modules"]["module_author"];
            let archive = &v["modules"]["module_dynamic"]["major"]["archive"];
            let bvid = archive["bvid"].as_str().unwrap_or("");
            // type=video 下仍防御性过滤：无 bvid 的项（如充电专属占位）无法跳转详情
            if bvid.is_empty() {
                return None;
            }
            Some(DynamicItem {
                bvid: bvid.to_string(),
                title: archive["title"].as_str().unwrap_or("").to_string(),
                cover: http_to_https(archive["cover"].as_str().unwrap_or("")),
                upper_name: author["name"].as_str().unwrap_or("").to_string(),
                upper_mid: author["mid"].as_i64().unwrap_or(0),
                upper_face: http_to_https(author["face"].as_str().unwrap_or("")),
                pub_ts: author["pub_ts"].as_i64().unwrap_or(0),
                pub_action: author["pub_action"].as_str().unwrap_or("").to_string(),
                play_text: archive["stat"]["play"].as_str().unwrap_or("").to_string(),
                danmaku_text: archive["stat"]["danmaku"].as_str().unwrap_or("").to_string(),
                duration_text: archive["duration_text"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();

    let result = DynamicFeedResult {
        items,
        offset: data["offset"].as_str().unwrap_or("").to_string(),
        has_more: data["has_more"].as_bool().unwrap_or(false),
    };

    log::info!(
        "[dynamic] 获取到 {} 条视频动态，has_more={}",
        result.items.len(),
        result.has_more
    );

    Ok(result)
}
