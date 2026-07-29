use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 分区视频条目（newlist 最新视频流）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionItem {
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
}

/// 获取分区最新视频列表（公开接口，无需登录）
/// API: GET https://api.bilibili.com/x/web-interface/newlist
///   rid：分区 tid（1=动画 3=音乐 4=游戏 ...，见前端 TID_OPTIONS）
///   pn/ps：页码 / 页大小
///
/// 注：旧的 dynamic/region 接口已被 B站 下线（返回 -404「啥都木有」），
/// 改用 newlist。两者数据结构一致（都在 data.archives，字段名相同），只需换 URL + 加 pn 参数。
/// 同样返回该分区最新发布的视频（非排行）。
///
/// @param rid 分区 id
/// @param ps 每页数量
/// @param credential 可选登录态：已登录则带 cookie
pub async fn get_region(
    rid: u32,
    ps: u32,
    credential: Option<&Credential>,
) -> Result<Vec<RegionItem>> {
    // 共享 api_client()：内置 UA + cookie_store(false) + API_TIMEOUT，
    // 避免某个挂起的连接永久阻塞异步任务。
    let client = api_client();

    let rid_s = rid.to_string();
    let ps_s = ps.to_string();
    let mut req = client
        .get("https://api.bilibili.com/x/web-interface/newlist")
        .header("Referer", REFERER)
        .query(&[
            ("rid", rid_s.as_str()),
            ("pn", "1"),
            ("ps", ps_s.as_str()),
        ]);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[region] rid={} 响应前 500 字: {}",
        rid,
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("分区视频响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取分区视频失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    // newlist 与旧 region 接口一致，数据均在 data.archives
    let list = resp["data"]["archives"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<RegionItem> = list
        .into_iter()
        .map(|v| RegionItem {
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
        })
        // 没有 bvid 的项（如广告位）无法跳转详情，过滤
        .filter(|it| !it.bvid.is_empty())
        .collect();

    log::info!("[region] rid={} 获取到 {} 条视频", rid, items.len());

    Ok(items)
}
