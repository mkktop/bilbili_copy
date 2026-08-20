use crate::bilibili::credential::Credential;
use crate::bilibili::{PagedResult, REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 评论条目（视频评论，data.replies 元素）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentItem {
    /// 评论 rpid（唯一 id）
    pub rpid: i64,
    /// 评论内容（纯文本，emoji 以文本形式展示）
    pub content: String,
    /// 评论者用户名
    pub uname: String,
    /// 评论者头像 URL
    pub avatar: String,
    /// 评论者 mid
    #[serde(default)]
    pub mid: i64,
    /// 评论者等级
    #[serde(default)]
    pub level: i64,
    /// 点赞数
    #[serde(default)]
    pub like: i64,
    /// 回复数（楼中楼）
    #[serde(default)]
    pub reply_count: i64,
    /// 发布时间（unix 秒）
    #[serde(default)]
    pub ctime: i64,
    /// 楼层
    #[serde(default)]
    pub floor: i64,
}

/// 获取视频评论（分页）
/// API: GET https://api.bilibili.com/x/v2/reply
///   type=1：oid 是 aid（视频）
///   pn：页码（从 1 开始）
///   ps：页大小（固定 20）
///   mode：3=按热度，2=按时间
///
/// 注：评论接口为公开接口，未登录也可查看。返回 data.page.count 为评论总数，
/// data.replies 为本页评论数组。data.replies 可能为 null（无评论时）。
///
/// @param aid 视频 aid（作为 oid）
/// @param pn 页码，从 1 开始
/// @param mode 排序：3=按热度（默认），2=按时间
/// @param credential 可选登录态：已登录则带 cookie
pub async fn get_comments(
    aid: i64,
    pn: u32,
    mode: u32,
    credential: Option<&Credential>,
) -> Result<PagedResult<CommentItem>> {
    // 共享 api_client()：内置 UA + cookie_store(false) + API_TIMEOUT。
    let client = api_client();

    let aid_s = aid.to_string();
    let pn_s = pn.to_string();
    let mode_s = if mode == 2 { "2" } else { "3" };
    let mut req = client
        .get("https://api.bilibili.com/x/v2/reply")
        .header("Referer", REFERER)
        .query(&[
            ("type", "1"),
            ("oid", aid_s.as_str()),
            ("pn", pn_s.as_str()),
            ("ps", "20"),
            ("mode", mode_s),
        ]);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;

    log::debug!(
        "[comment] aid={} pn={} mode={} 响应前 500 字: {}",
        aid,
        pn,
        mode_s,
        resp_text.chars().take(500).collect::<String>()
    );

    let resp: Value =
        serde_json::from_str(&resp_text).context("评论响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取评论失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    // 评论总数在 data.page.count
    let total = resp["data"]["page"]["count"].as_i64().unwrap_or(0);

    // data.replies 可能为 null（无评论），unwrap_or_default 兜底
    let list = resp["data"]["replies"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<CommentItem> = list
        .into_iter()
        .map(parse_comment_item)
        .filter(|it| it.rpid > 0)
        .collect();

    // 是否还有更多：已获取条数 < 总数
    let fetched = (pn as i64) * 20;
    let has_more = fetched < total;

    log::info!(
        "[comment] aid={} pn={} mode={} 获取到 {} 条评论（共 {} 条）",
        aid,
        pn,
        mode_s,
        items.len(),
        total
    );

    Ok(PagedResult {
        items,
        total,
        has_more,
        page: pn,
    })
}

/// 获取楼中楼回复（某条评论下的回复列表，分页）
/// API: GET https://api.bilibili.com/x/v2/reply/reply?type=1&oid={aid}&root={rpid}&pn=&ps=20
///
/// 响应 data.replies 的首项是根评论自身的快照，这里过滤掉只返回子回复；
/// data.page.count 为子回复总数（不含根评论）。
pub async fn get_replies(
    aid: i64,
    root: i64,
    pn: u32,
    credential: Option<&Credential>,
) -> Result<PagedResult<CommentItem>> {
    let client = api_client();

    let aid_s = aid.to_string();
    let root_s = root.to_string();
    let pn_s = pn.to_string();
    let mut req = client
        .get("https://api.bilibili.com/x/v2/reply/reply")
        .header("Referer", REFERER)
        .query(&[
            ("type", "1"),
            ("oid", aid_s.as_str()),
            ("root", root_s.as_str()),
            ("pn", pn_s.as_str()),
            ("ps", "20"),
        ]);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }

    let resp_text = req.send().await?.text().await?;
    let resp: Value =
        serde_json::from_str(&resp_text).context("楼中楼响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取楼中楼失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["page"]["count"].as_i64().unwrap_or(0);
    let list = resp["data"]["replies"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<CommentItem> = list
        .into_iter()
        .map(parse_comment_item)
        // 首项是根评论快照，过滤掉避免与外层评论重复
        .filter(|it| it.rpid > 0 && it.rpid != root)
        .collect();

    let fetched = (pn as i64) * 20;
    let has_more = fetched < total;

    log::info!(
        "[comment] 楼中楼 aid={} root={} pn={} 获取 {} 条（共 {} 条）",
        aid,
        root,
        pn,
        items.len(),
        total
    );

    Ok(PagedResult {
        items,
        total,
        has_more,
        page: pn,
    })
}

/// data.replies 单元素 → CommentItem（主评论与楼中楼结构一致，共用解析）
fn parse_comment_item(v: Value) -> CommentItem {
    CommentItem {
        rpid: v["rpid"].as_i64().unwrap_or(0),
        // content.message 是纯文本内容；若含 emoji 表情包会嵌套，这里取 message 兜底
        content: v["content"]["message"].as_str().unwrap_or("").to_string(),
        uname: v["member"]["uname"].as_str().unwrap_or("").to_string(),
        avatar: http_to_https(v["member"]["avatar"].as_str().unwrap_or("")),
        mid: v["mid"].as_i64().unwrap_or(0),
        level: v["member"]["level_info"]["current_level"]
            .as_i64()
            .unwrap_or(0),
        like: v["like"].as_i64().unwrap_or(0),
        reply_count: v["rcount"].as_i64().unwrap_or(0),
        ctime: v["ctime"].as_i64().unwrap_or(0),
        floor: v["floor"].as_i64().unwrap_or(0),
    }
}
