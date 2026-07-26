use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 排行榜条目：通用视频字段 + 名次 + 综合分 + 点赞
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingItem {
    /// 名次 1..100
    pub rank: i32,
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
    /// 综合得分（B站排行计算用）
    #[serde(default)]
    pub score: i64,
    #[serde(default)]
    pub like: i64,
}

/// 获取排行榜视频列表（公开接口，无需登录）
/// API: GET https://api.bilibili.com/x/web-interface/ranking/v2
///   rid=0 全站，否则为分区 tid
///   type=all 全站综合（不做 origin/rookie 区分）
///
/// 注：老的 /ranking (v1) 接口对 day!=3 已失效（返回空），v2 接口只返回
/// 综合榜（无 day 参数）。所以这里不再支持日/周/月榜筛选。
///
/// @param rid 分区 id，0 = 全站
/// @param credential 可选登录态：已登录则带 cookie（部分内容可能有更好结果）
pub async fn get_ranking(
    rid: u32,
    credential: Option<&Credential>,
) -> Result<Vec<RankingItem>> {
    let client = api_client();

    // query 元组需类型一致（&str 与 &String 不能混），故先取 &str 引用
    let rid_s = rid.to_string();
    let mut req = client
        .get("https://api.bilibili.com/x/web-interface/ranking/v2")
        .header("Referer", REFERER)
        .query(&[
            ("rid", rid_s.as_str()),
            ("type", "all"),
        ]);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[ranking] ranking 响应: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("排行榜响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取排行榜失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    // rank 字段优先用接口返回值，缺失则按下标 +1 推断（v2 不返回 rank）
    let items: Vec<RankingItem> = list
        .into_iter()
        .enumerate()
        .map(|(idx, v)| RankingItem {
            rank: v["rank"].as_i64().unwrap_or(idx as i64 + 1) as i32,
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
            upper_mid: v["owner"]["mid"].as_i64().unwrap_or(0),
            // v2 返回数字秒数；v1 返回 "mm:ss" 字符串。先试数字，失败再按字符串解析
            duration: v["duration"]
                .as_i64()
                .unwrap_or_else(|| parse_length(v["duration"].as_str().unwrap_or("0:0"))),
            play: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
            pubdate: v["pubdate"].as_i64().unwrap_or(0),
            score: v["score"].as_i64().unwrap_or(0),
            like: v["stat"]["like"].as_i64().unwrap_or(0),
        })
        .collect();

    log::info!("[ranking] rid={} 获取到 {} 条排行", rid, items.len());

    Ok(items)
}

/// 将 "mm:ss" 或 "hh:mm:ss" 转为秒（ranking 接口的 duration 是字符串）
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
        // 纯数字按秒处理（部分分区接口可能返回数字字符串）
        _ => s.parse::<i64>().unwrap_or(0),
    }
}
