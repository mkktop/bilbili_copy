use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, USER_AGENT, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// PGC 排行榜条目（番剧/国创/电影等维度，非单视频）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgcRankItem {
    /// 名次 1..100
    pub rank: i32,
    /// 番剧季 ID（用于 season API 解析到单集）
    pub season_id: u64,
    /// 番剧/电影名
    pub title: String,
    /// 横向封面（ss_horizontal_cover 优先，回退 cover）
    pub cover: String,
    /// 综合分（PGC 接口真实返回，UGC 接口的 v2 没有）
    #[serde(default)]
    pub score: i64,
    /// 状态标签（如「全12话」「已完结」）
    #[serde(default)]
    pub badge: String,
    /// 简介
    #[serde(default)]
    pub desc: String,
    /// 播放量
    #[serde(default)]
    pub views: i64,
    /// 弹幕数
    #[serde(default)]
    pub danmaku: i64,
}

fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 获取 PGC 排行榜（番剧/国创/电影/电视剧/纪录片/综艺）
/// API: GET https://api.bilibili.com/pgc/season/rank/web/list
///   season_type: 1=番剧 2=电影 3=纪录片 4=国创 5=电视剧 7=综艺
///
/// 注：B站 PGC 排行榜实际只支持三日榜（day=1/7 返回空），故固定传 day=3。
///
/// @param credential 可选登录态：已登录则带 cookie
pub async fn get_pgc_rank(
    season_type: u8,
    credential: Option<&Credential>,
) -> Result<Vec<PgcRankItem>> {
    let client = bilibili_client()?;

    let st_s = season_type.to_string();
    let mut req = client
        .get("https://api.bilibili.com/pgc/season/rank/web/list")
        .header("Referer", REFERER)
        .query(&[
            ("season_type", st_s.as_str()),
            ("day", "3"),
        ]);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[pgc] season_type={} 响应前 300 字: {}",
        season_type,
        &resp_text[..resp_text.len().min(300)]
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("PGC 排行榜响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取 PGC 排行榜失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    // PGC 接口在 result.list（PGC view 系列接口常见结构），不是 data.list
    let list = resp["result"]["list"]
        .as_array()
        .or_else(|| resp["data"]["list"].as_array())
        .cloned()
        .unwrap_or_default();

    // rank 字段优先用接口返回值，缺失则按下标 +1 推断
    let items: Vec<PgcRankItem> = list
        .into_iter()
        .enumerate()
        .map(|(idx, v)| PgcRankItem {
            rank: v["rank"].as_i64().unwrap_or(idx as i64 + 1) as i32,
            season_id: v["season_id"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").to_string(),
            // 优先横向封面（适合卡片宽幅展示），回退到正方形 cover
            cover: http_to_https(
                v["ss_horizontal_cover"]
                    .as_str()
                    .or_else(|| v["cover"].as_str())
                    .unwrap_or(""),
            ),
            score: v["score"].as_i64().unwrap_or(0),
            badge: v["badge"].as_str().unwrap_or("").to_string(),
            desc: v["desc"].as_str().unwrap_or("").to_string(),
            views: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
        })
        .filter(|it| it.season_id > 0) // 没有 season_id 的项无法跳转详情，过滤
        .collect();

    log::info!(
        "[pgc] season_type={} 获取到 {} 条 PGC 排行",
        season_type,
        items.len()
    );

    Ok(items)
}
