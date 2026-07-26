use crate::bilibili::credential::Credential;
use crate::bilibili::{PagedResult, REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 观看历史条目：基于通用视频列表项，额外携带观看进度
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub bvid: String,
    pub title: String,
    pub cover: String,
    #[serde(default)]
    pub upper_name: String,
    #[serde(default)]
    pub upper_mid: i64,
    /// 时长（秒）
    #[serde(default)]
    pub duration: i64,
    #[serde(default)]
    pub play: i64,
    #[serde(default)]
    pub danmaku: i64,
    #[serde(default)]
    pub pubdate: i64,
    /// 观看时间（unix 秒）
    pub view_at: i64,
    /// 已观看秒数
    #[serde(default)]
    pub progress: i64,
}

/// 获取当前登录用户的观看历史（cursor 分页）
/// API: GET https://api.bilibili.com/x/web-interface/history/cursor
/// 鉴权：cookie（无需 WBI 签名）
///
/// cursor 分页机制：
/// - 首页 max_view_at 传 None
/// - 后端响应 data.cursor 返回下一页所需的 {max, view_at, business}
/// - 调用方把上一次返回的最后一条 view_at 作为下一次的 max_view_at
///
/// @param max_view_at 上一页最后一条的 view_at（首页传 None）
pub async fn get_watch_history(
    max_view_at: Option<i64>,
    credential: &Credential,
) -> Result<PagedResult<HistoryItem>> {
    let client = api_client();
    let page_size = 20i64;

    // 按 bilibili-API-collect 文档：首页不带游标；翻页用上次最后一条的 view_at。
    // （注意是 view_at 不是 max —— max 是限定上限，view_at 才是游标）
    let mut query: Vec<(&str, String)> = vec![("ps", page_size.to_string())];
    if let Some(ts) = max_view_at {
        query.push(("view_at", ts.to_string()));
    }

    let resp_text = client
        .get("https://api.bilibili.com/x/web-interface/history/cursor")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&query)
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[history] history/cursor 响应前 500 字: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("观看历史响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取观看历史失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    // 保留所有有 bvid 的记录（archive=UGC视频，pgc=番剧等也可能有 bvid）。
    // 只过滤掉无 bvid 的（直播、文章等无法跳详情）。
    let items: Vec<HistoryItem> = list
        .into_iter()
        .filter(|v| {
            !v["history"]["bvid"].as_str().unwrap_or("").is_empty()
        })
        .map(|v| {
            // progress 主流放在 history.progress，个别业务放顶层 progress
            let progress = v["history"]["progress"]
                .as_i64()
                .or_else(|| v["progress"].as_i64())
                .unwrap_or(0);
            HistoryItem {
                bvid: v["history"]["bvid"].as_str().unwrap_or("").to_string(),
                title: v["title"].as_str().unwrap_or("(已失效视频)").to_string(),
                cover: http_to_https(v["cover"].as_str().unwrap_or("")),
                upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
                upper_mid: v["owner"]["mid"].as_i64().unwrap_or(0),
                duration: v["history"]["duration"].as_i64().unwrap_or(0),
                play: v["stat"]["view"].as_i64().unwrap_or(0),
                danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
                pubdate: v["pubdate"].as_i64().unwrap_or(0),
                view_at: v["view_at"].as_i64().unwrap_or(0),
                progress,
            }
        })
        .collect();

    // has_more 判断：cursor 返回下一页游标（view_at > 0）即可能有更早的历史。
    // 不依赖 items.len() == page_size，因为首页/末页可能不足一页但仍有后续。
    let has_more = resp["data"]["cursor"]["view_at"]
        .as_i64()
        .unwrap_or(0)
        > 0
        && !items.is_empty();

    log::info!(
        "[history] 获取到 {} 条观看历史（max_view_at={:?}, has_more={}）",
        items.len(),
        max_view_at,
        has_more
    );

    // total 用 -1 表示 cursor 接口不返回总数（前端只关心 has_more）
    Ok(PagedResult {
        items,
        total: -1,
        has_more,
        page: 0,
    })
}
