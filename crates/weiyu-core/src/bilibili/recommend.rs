use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 推荐视频条目（首页推荐流，data.item 结构）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendItem {
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
    /// 发布时间（unix 秒），0 表示未知
    #[serde(default)]
    pub pubdate: i64,
    #[serde(default)]
    pub like: i64,
    /// 推荐理由（如「关注」「赞过」），可能为空
    #[serde(default)]
    pub rcmd_reason: String,
}

/// 获取首页推荐视频流
/// API: GET https://api.bilibili.com/x/web-interface/index/top/rcmd
///   fresh_type=4（Web 端首页刷新类型）
///   ps=30（页大小，与 B站首页一致）
///   fresh_idx：刷新索引，每次刷新 +1，服务端据此去重「看过的不再推荐」
///
/// 注：此接口为个性化推荐流，**需登录态**（带 cookie）才会返回个性化内容；
/// 未登录虽可返回通用热门，但本应用策略是要求登录。
///
/// 返回数据在 data.item（注意是 item 不是 list）。
///
/// @param fresh_idx 刷新索引，首次传 1，后续递增
/// @param credential 必须的登录态（调用方保证非 None）
pub async fn get_recommend(
    fresh_idx: u32,
    credential: Option<&Credential>,
) -> Result<Vec<RecommendItem>> {
    // 共享 api_client()：内置 UA + cookie_store(false) + API_TIMEOUT，
    // 避免某个挂起的连接永久阻塞异步任务。
    let client = api_client();

    let fi_s = fresh_idx.to_string();
    let mut req = client
        .get("https://api.bilibili.com/x/web-interface/index/top/rcmd")
        .header("Referer", REFERER)
        .query(&[
            ("fresh_type", "4"),
            ("fresh_idx", fi_s.as_str()),
            ("version", "1"),
        ]);
    // 注：不传 ps 参数。该接口对 ps 有上限校验（实测 ps=30 返回 -400「请求错误」），
    // 用接口默认值即可，实际返回约 24 条。
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[recommend] fresh_idx={} 响应前 500 字: {}",
        fresh_idx,
        resp_text.chars().take(500).collect::<String>()
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("推荐流响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取推荐流失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    // 推荐流数据在 data.item（区别于排行榜的 data.list）
    let list = resp["data"]["item"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<RecommendItem> = list
        .into_iter()
        .map(|v| RecommendItem {
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
            upper_mid: v["owner"]["mid"].as_i64().unwrap_or(0),
            duration: v["duration"].as_i64().unwrap_or(0),
            play: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
            pubdate: v["pubdate"].as_i64().unwrap_or(0),
            like: v["stat"]["like"].as_i64().unwrap_or(0),
            // rcmd_reason.content 是推荐理由文案（如「关注」「赞过」），无理由则为空
            rcmd_reason: v["rcmd_reason"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        })
        // 没有 bvid 的项（如广告位）无法跳转详情，过滤
        .filter(|it| !it.bvid.is_empty())
        .collect();

    log::info!(
        "[recommend] fresh_idx={} 获取到 {} 条推荐",
        fresh_idx,
        items.len()
    );

    Ok(items)
}
