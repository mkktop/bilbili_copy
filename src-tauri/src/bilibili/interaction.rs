use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client};
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
    let client = api_client();

    // csrf 必须同时出现在表单和 Cookie 中（bili_jct）
    let mut form = form;
    form.push(("csrf", credential.bili_jct.clone()));

    let resp_text = client
        .post(url)
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .form(&form)
        .send()
        .await?
        .text()
        .await?;

    log::debug!("[interaction] POST {} 响应前 300 字: {}", url, resp_text.chars().take(300).collect::<String>());

    let resp: Value =
        serde_json::from_str(&resp_text).context("互动接口响应解析失败")?;

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

    Ok(())
}

/// 点赞视频
/// API: POST https://api.bilibili.com/x/web-interface/archive/like
///   like: 1=点赞，2=取消点赞
pub async fn like_video(credential: &Credential, bvid: &str, like: u8) -> Result<()> {
    interaction_post(
        "https://api.bilibili.com/x/web-interface/archive/like",
        vec![
            ("like", like.to_string()),
            ("bvid", bvid.to_string()),
        ],
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
pub async fn favorite_video(
    credential: &Credential,
    aid: i64,
    folder_id: i64,
) -> Result<()> {
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
