use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
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

/// 追番/追剧条目（x/space/bangumi/follow/list）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BangumiFollowItem {
    /// 番剧季 ID（解析 ss{season_id} 进详情）
    pub season_id: u64,
    pub title: String,
    pub cover: String,
    /// 内容形态名（番剧/电影/纪录片…）
    #[serde(default)]
    pub season_type_name: String,
    /// 状态角标（如「会员专享」）
    #[serde(default)]
    pub badge: String,
    /// 更新状态文案（如「更新至第12话」「全26话」）
    #[serde(default)]
    pub new_ep_show: String,
    /// 观看进度文案（如「看到第3话」，未看过为空）
    #[serde(default)]
    pub progress: String,
    /// 评分（x10 前的原始分，如 9.7；无评分为 0）
    #[serde(default)]
    pub score: f64,
    /// 是否完结
    #[serde(default)]
    pub is_finish: bool,
}

/// 追番/追剧分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BangumiFollowResult {
    pub items: Vec<BangumiFollowItem>,
    pub total: i64,
    pub has_more: bool,
    pub page: u32,
}

/// 获取追番/追剧列表（需登录）
/// API: GET https://api.bilibili.com/x/space/bangumi/follow/list
///   type: 1=追番（番剧/国创） 2=追剧（电影/电视剧/纪录片/综艺）
///   vmid: 登录用户自己的 mid（从凭证 dedeuserid 取）
pub async fn get_bangumi_follow(
    follow_type: u8,
    page: u32,
    credential: &Credential,
) -> Result<BangumiFollowResult> {
    let client = api_client();
    const PS: u32 = 20;

    let ft_s = follow_type.to_string();
    let pn_s = page.to_string();
    let ps_s = PS.to_string();
    let resp_text = client
        .get("https://api.bilibili.com/x/space/bangumi/follow/list")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&[
            ("type", ft_s.as_str()),
            ("follow_status", "0"), // 0=全部（想看/在看/看过）
            ("pn", pn_s.as_str()),
            ("ps", ps_s.as_str()),
            ("vmid", credential.dedeuserid.as_str()),
        ])
        .send()
        .await?
        .text()
        .await?;

    let resp: Value = serde_json::from_str(&resp_text).context("追番列表响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取追番列表失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["total"].as_i64().unwrap_or(0);
    let list = resp["data"]["list"].as_array().cloned().unwrap_or_default();

    let items: Vec<BangumiFollowItem> = list
        .into_iter()
        .map(|v| BangumiFollowItem {
            season_id: v["season_id"].as_u64().unwrap_or(0),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["cover"].as_str().unwrap_or("")),
            season_type_name: v["season_type_name"].as_str().unwrap_or("").to_string(),
            badge: v["badge"].as_str().unwrap_or("").to_string(),
            new_ep_show: v["new_ep"]["index_show"].as_str().unwrap_or("").to_string(),
            progress: v["progress"].as_str().unwrap_or("").to_string(),
            score: v["rating"]["score"].as_f64().unwrap_or(0.0),
            is_finish: v["is_finish"].as_i64().unwrap_or(0) == 1,
        })
        .filter(|it| it.season_id > 0)
        .collect();

    let has_more = (page * PS) < total as u32;

    log::info!(
        "[pgc] 追番列表 type={} page={} 获取到 {} 条（共 {}）",
        follow_type, page, items.len(), total
    );

    Ok(BangumiFollowResult { items, total, has_more, page })
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
    // 共享 api_client()：内置 UA + cookie_store(false) + API_TIMEOUT，
    // 避免某个挂起的连接永久阻塞异步任务。
    let client = api_client();

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
