use crate::bilibili::credential::Credential;
use crate::bilibili::{api_client, ORIGIN, REFERER};
use anyhow::{Context, Result};
use serde_json::Value;

/// 发送已认证的互动 POST 请求（点赞/投币/收藏/稍后再看增删）。
///
/// 统一处理：Cookie 注入、csrf 表单字段、code != 0 报错、风控 v_voucher 检测。
///
/// 基础版策略：命中风控时直接 bail 并带可读提示，不自动重试（用户手动重试）。
/// 互动类接口（like/coin/favorite）触发风控的概率远低于下载 playurl，故此策略可接受。
pub(crate) async fn interaction_post(
    url: &str,
    form: Vec<(&str, String)>,
    credential: &Credential,
) -> Result<()> {
    interaction_post_json(url, form, credential)
        .await
        .map(|_| ())
}

/// 与 [`interaction_post`] 相同，但返回完整 JSON 响应（评论需要 data.rpid）。
pub(crate) async fn interaction_post_json(
    url: &str,
    form: Vec<(&str, String)>,
    credential: &Credential,
) -> Result<Value> {
    let client = api_client();

    // csrf 必须同时出现在表单和 Cookie 中（bili_jct）
    let mut form = form;
    form.push(("csrf", credential.bili_jct.clone()));

    let resp_text = client
        .post(url)
        .header("Referer", REFERER)
        // 实测（2026-08，v1.1.1 冒烟测试发现）：缺 Origin 时 B站对 toview/add 等
        // 互动 POST 返回 code=0 但静默不生效——点赞/投币/收藏/稍后再看全部受影响。
        .header("Origin", ORIGIN)
        .header("Cookie", credential.cookie_header())
        .form(&form)
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[interaction] POST {} 响应前 300 字: {}",
        url,
        resp_text.chars().take(300).collect::<String>()
    );

    let resp: Value = serde_json::from_str(&resp_text).context("互动接口响应解析失败")?;

    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        // 风控检测：响应含 v_voucher 字段时提示用户验证
        let voucher = resp["data"]["v_voucher"]
            .as_str()
            .or_else(|| resp["v_voucher"].as_str());
        if let Some(vv) = voucher {
            if !vv.is_empty() {
                anyhow::bail!("触发风控验证，请稍后重试（v_voucher: {}）", vv);
            }
        }
        anyhow::bail!(
            "操作失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    Ok(resp)
}

/// 点赞视频
/// API: POST https://api.bilibili.com/x/web-interface/archive/like
///   like: 1=点赞，2=取消点赞
pub async fn like_video(credential: &Credential, bvid: &str, like: u8) -> Result<()> {
    interaction_post(
        "https://api.bilibili.com/x/web-interface/archive/like",
        vec![("like", like.to_string()), ("bvid", bvid.to_string())],
        credential,
    )
    .await
}

/// 投币视频
/// API: POST https://api.bilibili.com/x/web-interface/coin/add
///   multiply: 投币数量（1 或 2）
///   select_like: 1=同时点赞，0=仅投币
pub async fn coin_video(
    credential: &Credential,
    bvid: &str,
    multiply: u8,
    select_like: u8,
) -> Result<()> {
    interaction_post(
        "https://api.bilibili.com/x/web-interface/coin/add",
        vec![
            ("bvid", bvid.to_string()),
            ("multiply", multiply.to_string()),
            ("select_like", select_like.to_string()),
        ],
        credential,
    )
    .await
}

/// 收藏视频到指定收藏夹
/// API: POST https://api.bilibili.com/x/v3/fav/resource/deal
///   type=2: 资源类型为视频
///   rid: 资源 id（视频 aid）
///   add_media_ids: 目标收藏夹 media_id（来自 get_user_favorite_folders）
pub async fn favorite_video(credential: &Credential, aid: i64, folder_id: i64) -> Result<()> {
    interaction_post(
        "https://api.bilibili.com/x/v3/fav/resource/deal",
        vec![
            ("type", "2".to_string()),
            ("rid", aid.to_string()),
            ("add_media_ids", folder_id.to_string()),
        ],
        credential,
    )
    .await
}

/// 发表评论后的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedComment {
    pub rpid: i64,
    pub root: i64,
    pub parent: i64,
}

/// 发表视频评论或回复。
///
/// API: POST https://api.bilibili.com/x/v2/reply/add
/// - `aid`: 视频 avid（不是 bvid）
/// - `parent`: 回复目标评论 rpid；回复一级评论时 root 自动等于 parent
/// - `mentions`: (昵称, mid) 列表；B站只有收到 `at_name_to_mid` 才会把正文里的
///   `@昵称` 变成真实提及并通知对方，正文必须自己带上 `@昵称`
pub async fn post_comment(
    credential: &Credential,
    aid: i64,
    message: &str,
    root: Option<i64>,
    parent: Option<i64>,
    mentions: &[(String, i64)],
) -> Result<PostedComment> {
    let form = comment_form(aid, message, root, parent, mentions)?;
    let resp =
        interaction_post_json("https://api.bilibili.com/x/v2/reply/add", form, credential).await?;

    let data = &resp["data"];
    let rpid = data["rpid"].as_i64().unwrap_or(0);
    if rpid == 0 {
        anyhow::bail!("评论接口未返回 rpid（可能已被风控拦截）");
    }
    Ok(PostedComment {
        rpid,
        root: data["root"].as_i64().unwrap_or(0),
        parent: data["parent"].as_i64().unwrap_or(0),
    })
}

/// 构造评论表单并做本地校验（便于单测）。
fn comment_form(
    aid: i64,
    message: &str,
    root: Option<i64>,
    parent: Option<i64>,
    mentions: &[(String, i64)],
) -> Result<Vec<(&'static str, String)>> {
    if aid <= 0 {
        anyhow::bail!("非法的视频 aid: {aid}");
    }
    let message = message.trim();
    if message.is_empty() {
        anyhow::bail!("评论内容不能为空");
    }
    if message.chars().count() > 1000 {
        anyhow::bail!("评论内容不能超过1000字符");
    }
    if root.is_some_and(|value| value <= 0) || parent.is_some_and(|value| value <= 0) {
        anyhow::bail!("评论 rpid 必须为正整数");
    }
    if root.is_some() && parent.is_none() {
        anyhow::bail!("回复评论时必须提供 parent");
    }

    let mut form = vec![
        ("type", "1".to_string()),
        ("oid", aid.to_string()),
        ("message", message.to_string()),
        ("plat", "1".to_string()),
    ];
    if let Some(parent) = parent {
        // 回复一级评论：root 与 parent 相同
        let root = root.unwrap_or(parent);
        form.push(("root", root.to_string()));
        form.push(("parent", parent.to_string()));
    }
    if !mentions.is_empty() {
        if mentions.len() > 20 {
            anyhow::bail!("一次最多@20个用户");
        }
        let mut map = serde_json::Map::new();
        for (name, mid) in mentions {
            let name = name.trim();
            if name.is_empty() || *mid <= 0 {
                anyhow::bail!("非法的@用户参数: name={name:?}, mid={mid}");
            }
            map.insert(name.to_string(), serde_json::json!(mid));
        }
        form.push(("at_name_to_mid", Value::Object(map).to_string()));
    }
    Ok(form)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form_map(
        form: &[(&'static str, String)],
    ) -> std::collections::HashMap<&'static str, String> {
        form.iter().cloned().collect()
    }

    #[test]
    fn comment_form_rejects_empty_and_long_messages() {
        assert!(comment_form(1, "   ", None, None, &[]).is_err());
        let long = "字".repeat(1001);
        assert!(comment_form(1, &long, None, None, &[]).is_err());
        assert!(comment_form(1, "短评", None, None, &[]).is_ok());
    }

    #[test]
    fn comment_form_reply_defaults_root_to_parent() {
        let form = form_map(&comment_form(170001, "测试", None, Some(123), &[]).unwrap());
        assert_eq!(form.get("root").map(String::as_str), Some("123"));
        assert_eq!(form.get("parent").map(String::as_str), Some("123"));
        assert_eq!(form.get("oid").map(String::as_str), Some("170001"));
        assert_eq!(form.get("type").map(String::as_str), Some("1"));
        assert_eq!(form.get("plat").map(String::as_str), Some("1"));
    }

    #[test]
    fn comment_form_keeps_explicit_root_for_nested_reply() {
        let form = form_map(&comment_form(1, "测试", Some(100), Some(200), &[]).unwrap());
        assert_eq!(form.get("root").map(String::as_str), Some("100"));
        assert_eq!(form.get("parent").map(String::as_str), Some("200"));
    }

    #[test]
    fn comment_form_rejects_root_without_parent() {
        assert!(comment_form(1, "测试", Some(100), None, &[]).is_err());
    }

    #[test]
    fn comment_form_serializes_mentions() {
        let form = form_map(
            &comment_form(
                1,
                "你好 @张三 @李四",
                None,
                None,
                &[("张三".to_string(), 11), ("李四".to_string(), 22)],
            )
            .unwrap(),
        );
        let raw = form.get("at_name_to_mid").expect("应带 at_name_to_mid");
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value["张三"], 11);
        assert_eq!(value["李四"], 22);
    }

    #[test]
    fn comment_form_validates_mentions() {
        assert!(comment_form(1, "测试", None, None, &[(" ".to_string(), 1)]).is_err());
        assert!(comment_form(1, "测试", None, None, &[("张三".to_string(), 0)]).is_err());
        let many: Vec<(String, i64)> = (0..21).map(|i| (format!("u{i}"), i + 1)).collect();
        assert!(comment_form(1, "测试", None, None, &many).is_err());
    }
}
