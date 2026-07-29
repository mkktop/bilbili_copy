use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 每周必看期数条目（series/list 返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklySeriesItem {
    /// 期数
    pub number: i64,
    /// 主题（如「身残志坚钻石大盗」）
    pub subject: String,
    /// 状态（2=已结束）
    pub status: i64,
    /// 名称（如「2024第279期 07.19 - 07.25」）
    pub name: String,
}

/// 每周必看选期配置（series/one 返回的 config）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyConfig {
    pub number: i64,
    pub subject: String,
    pub name: String,
    /// 开始时间（unix 秒）
    pub stime: i64,
    /// 结束时间（unix 秒）
    pub etime: i64,
    /// 封面
    pub cover: String,
    /// 提示（如「本周热词：」）
    pub hint: String,
}

/// 每周必看视频条目（series/one 返回的 list 项）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyVideoItem {
    pub bvid: String,
    pub aid: i64,
    pub cid: i64,
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
    pub like: i64,
    #[serde(default)]
    pub pubdate: i64,
    /// 分区名（如「科学科普」）
    #[serde(default)]
    pub tname: String,
    /// 推荐理由（编辑精选文案）
    #[serde(default)]
    pub rcmd_reason: String,
}

/// 每周必看选期详情（config + 视频列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyDetail {
    pub config: WeeklyConfig,
    /// 提醒（如「每周五晚18:00更新」）
    pub reminder: String,
    pub list: Vec<WeeklyVideoItem>,
}

/// 获取每周必看全部期数列表（公开接口，无需登录）
/// API: GET https://api.bilibili.com/x/web-interface/popular/series/list
///
/// 返回按期数降序排列（最新一期在前）。
pub async fn get_weekly_series_list(
    credential: Option<&Credential>,
) -> Result<Vec<WeeklySeriesItem>> {
    let client = api_client();
    let mut req = client
        .get("https://api.bilibili.com/x/web-interface/popular/series/list")
        .header("Referer", REFERER);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[weekly] series/list 响应: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("每周必看列表响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取每周必看列表失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let list = resp["data"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<WeeklySeriesItem> = list
        .into_iter()
        .map(|v| WeeklySeriesItem {
            number: v["number"].as_i64().unwrap_or(0),
            subject: v["subject"].as_str().unwrap_or("").to_string(),
            status: v["status"].as_i64().unwrap_or(2),
            name: v["name"].as_str().unwrap_or("").to_string(),
        })
        .collect();

    log::info!("[weekly] 获取到 {} 期每周必看", items.len());

    Ok(items)
}

/// 获取每周必看某期详细信息（公开接口，无需登录）
/// API: GET https://api.bilibili.com/x/web-interface/popular/series/one?number={n}
///
/// @param number 期数（不传则返回最新一期）
pub async fn get_weekly_detail(
    number: Option<i64>,
    credential: Option<&Credential>,
) -> Result<WeeklyDetail> {
    let client = api_client();

    let number_s = number.map(|n| n.to_string());
    let mut req = client
        .get("https://api.bilibili.com/x/web-interface/popular/series/one")
        .header("Referer", REFERER);
    if let Some(n) = &number_s {
        req = req.query(&[("number", n.as_str())]);
    }
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[weekly] series/one 响应: {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("每周必看详情响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取每周必看详情失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let data = &resp["data"];

    let config = WeeklyConfig {
        number: data["config"]["number"].as_i64().unwrap_or(0),
        subject: data["config"]["subject"].as_str().unwrap_or("").to_string(),
        name: data["config"]["name"].as_str().unwrap_or("").to_string(),
        stime: data["config"]["stime"].as_i64().unwrap_or(0),
        etime: data["config"]["etime"].as_i64().unwrap_or(0),
        cover: http_to_https(data["config"]["cover"].as_str().unwrap_or("")),
        hint: data["config"]["hint"].as_str().unwrap_or("").to_string(),
    };

    let reminder = data["reminder"].as_str().unwrap_or("").to_string();

    let list = data["list"].as_array().cloned().unwrap_or_default();

    let videos: Vec<WeeklyVideoItem> = list
        .into_iter()
        .map(|v| WeeklyVideoItem {
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            aid: v["aid"].as_i64().unwrap_or(0),
            cid: v["cid"].as_i64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
            upper_mid: v["owner"]["mid"].as_i64().unwrap_or(0),
            duration: v["duration"].as_i64().unwrap_or(0),
            play: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
            like: v["stat"]["like"].as_i64().unwrap_or(0),
            pubdate: v["pubdate"].as_i64().unwrap_or(0),
            tname: v["tname"].as_str().unwrap_or("").to_string(),
            // rcmd_reason 可能是字符串或对象（新版接口返回 {content, corner_mark}）
            rcmd_reason: match &v["rcmd_reason"] {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            },
        })
        .collect();

    log::info!(
        "[weekly] 第{}期获取到 {} 条视频",
        config.number,
        videos.len()
    );

    Ok(WeeklyDetail {
        config,
        reminder,
        list: videos,
    })
}
