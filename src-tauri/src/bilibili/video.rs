use crate::bilibili::credential::Credential;
use crate::bilibili::{USER_AGENT, REFERER, BilibiliResponse, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// 视频分P信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub cid: i64,
    pub page: u32,
    pub part: String,
    pub duration: u64,
    /// 番剧每集独立 bvid
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bvid: Option<String>,
    /// 番剧每集 ep_id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ep_id: Option<u64>,
}

/// 视频详细信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub bvid: String,
    pub aid: u64,
    pub title: String,
    pub desc: String,
    pub pic: String,
    pub owner_mid: u64,
    pub owner_name: String,
    pub owner_face: String,
    pub duration: u64,
    pub pages: Vec<PageInfo>,
    /// 番剧 ep_id，非番剧为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ep_id: Option<u64>,
    /// 预告/花絮等非正片内容
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extra_pages: Vec<PageInfo>,
    /// 播放量
    #[serde(default)]
    pub view_count: u64,
    /// 弹幕数
    #[serde(default)]
    pub danmaku_count: u64,
    /// 番剧系列名（不含集号），非番剧为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
}

/// view API 返回的 JSON 结构
#[derive(Debug, Deserialize)]
struct ViewData {
    bvid: String,
    aid: i64,
    title: String,
    desc: String,
    pic: String,
    #[serde(default)]
    duration: u64,
    owner: Option<ViewOwner>,
    #[serde(default)]
    pages: Vec<ViewPage>,
    #[serde(default)]
    stat: Option<ViewStat>,
}

#[derive(Debug, Deserialize)]
struct ViewStat {
    #[serde(default)]
    view: u64,
    #[serde(default)]
    danmaku: u64,
}

#[derive(Debug, Deserialize)]
struct ViewOwner {
    mid: i64,
    name: String,
    face: String,
}

#[derive(Debug, Deserialize)]
struct ViewPage {
    cid: i64,
    page: u32,
    part: String,
    #[serde(default)]
    duration: u64,
}

/// 将 media_id 解析为 season_id
/// API: https://api.bilibili.com/pgc/review/user?media_id={media_id}
async fn resolve_media_id(client: &Client, media_id: u64) -> Result<u64> {
    let resp = client
        .get("https://api.bilibili.com/pgc/review/user")
        .header("Referer", REFERER)
        .query(&[("media_id", media_id.to_string())])
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;
    let code = json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("media_id 解析失败: {}", json["message"].as_str().unwrap_or("未知错误"));
    }

    json["result"]["media"]["season_id"]
        .as_i64()
        .map(|v| v as u64)
        .context("media_id 响应中找不到 season_id")
}

/// 从 view API 的 -404 响应中提取番剧 ep_id
/// 按优先级尝试: redirect_url → season.episodes[0].id → epid 字段
fn extract_ep_from_redirect(resp_json: &serde_json::Value) -> Option<u64> {
    let data = resp_json.get("data")?;

    // 策略 1: redirect_url 包含 /bangumi/play/epXXX
    if let Some(url) = data["redirect_url"].as_str() {
        if url.contains("/bangumi/play/ep") {
            if let Some(start) = url.find("/ep") {
                let ep_part = &url[start + 3..];
                let digits: String = ep_part.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(ep_id) = digits.parse::<u64>() {
                    log::debug!("[video] 从 redirect_url 提取到 ep_id={}", ep_id);
                    return Some(ep_id);
                }
            }
        }
    }

    // 策略 2: season.episodes[0].id
    if let Some(first_ep) = data["season"]["episodes"].as_array().and_then(|a| a.first()) {
        if let Some(id) = first_ep["id"].as_i64() {
            log::debug!("[video] 从 season.episodes 提取到 ep_id={}", id);
            return Some(id as u64);
        }
    }

    // 策略 3: 直接 epid / episode_id 字段
    if let Some(id) = data["epid"].as_i64().or_else(|| data["episode_id"].as_i64()) {
        log::debug!("[video] 从 epid 字段提取到 ep_id={}", id);
        return Some(id as u64);
    }

    None
}

/// 创建 HTTP 客户端
fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 根据BV号/AV号/ep_id/season_id/media_id获取视频详细信息
pub async fn get_video_info(
    bvid: Option<&str>,
    aid: Option<u64>,
    ep_id: Option<u64>,
    season_id: Option<u64>,
    media_id: Option<u64>,
    credential: Option<&Credential>,
) -> Result<VideoInfo> {
    let client = bilibili_client()?;

    // media_id 需要先解析为 season_id
    let resolved_season_id = if season_id.is_none() {
        if let Some(mid) = media_id {
            match resolve_media_id(&client, mid).await {
                Ok(sid) => {
                    log::info!("[video] media_id={} 解析为 season_id={}", mid, sid);
                    Some(sid)
                }
                Err(e) => {
                    log::warn!("[video] media_id={} 解析失败: {}", mid, e);
                    None
                }
            }
        } else {
            None
        }
    } else {
        season_id
    };

    // 如果是番剧链接（ep_id 或 season_id），优先尝试番剧专用 season API
    if bvid.is_none() && aid.is_none() {
        if ep_id.is_some() || resolved_season_id.is_some() {
            let label = if let Some(ep) = ep_id {
                format!("ep_id={}", ep)
            } else {
                format!("season_id={}", resolved_season_id.unwrap())
            };
            log::info!("[video] 检测到番剧 {}, 先尝试番剧 season API", label);
            match try_bangumi_season_info(&client, ep_id, resolved_season_id, credential).await {
                Ok(info) => return Ok(info),
                Err(e) => {
                    log::warn!("[video] 番剧 season API 失败: {}, 回退到 view API", e);
                }
            }
        }
    }

    // 标准 view API
    let mut request = client
        .get("https://api.bilibili.com/x/web-interface/view")
        .header("Referer", REFERER);

    // 优先使用 bvid，其次 aid，最后 ep_id
    if let Some(bvid) = bvid {
        request = request.query(&[("bvid", bvid)]);
    } else if let Some(aid) = aid {
        request = request.query(&[("aid", &aid.to_string())]);
    } else if let Some(ep_id) = ep_id {
        request = request.query(&[("ep_id", &ep_id.to_string())]);
    } else {
        anyhow::bail!("必须提供 bvid、aid 或 ep_id");
    }

    // 如果已登录，带上 Cookie
    if let Some(cred) = credential {
        request = request.header("Cookie", cred.cookie_header());
    }

    // 先用原始 JSON 解析，以便处理 -404 + redirect_url 回退
    let resp_text = request.send().await?.text().await?;
    let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
        .context("视频信息响应解析失败")?;

    let resp_code = resp_json["code"].as_i64().unwrap_or(-1);

    // -404: 视频可能是番剧，尝试从 redirect_url 提取 ep_id
    if resp_code == -404 {
        if let Some(ep_id) = extract_ep_from_redirect(&resp_json) {
            log::info!("[video] view API 返回 -404，从 redirect_url 提取到 ep_id={}，走番剧流程", ep_id);
            return try_bangumi_season_info(&client, Some(ep_id), None, credential).await;
        }
    }

    if resp_code != 0 {
        anyhow::bail!(
            "获取视频信息失败: {}",
            resp_json["message"].as_str().unwrap_or("未知错误")
        );
    }

    let resp: BilibiliResponse<ViewData> = serde_json::from_value(resp_json)
        .context("视频信息反序列化失败")?;

    let data = resp.data.context("视频信息响应无 data")?;

    let owner = data.owner.unwrap_or(ViewOwner {
        mid: 0,
        name: "未知".to_string(),
        face: String::new(),
    });

    let pages: Vec<PageInfo> = data
        .pages
        .into_iter()
        .map(|p| PageInfo {
            cid: p.cid,
            page: p.page,
            part: p.part,
            duration: p.duration,
            bvid: None,
            ep_id: None,
        })
        .collect();

    Ok(VideoInfo {
        bvid: data.bvid,
        aid: data.aid as u64,
        title: data.title,
        desc: data.desc,
        pic: http_to_https(&data.pic),
        owner_mid: owner.mid as u64,
        owner_name: owner.name,
        owner_face: http_to_https(&owner.face),
        duration: data.duration,
        pages,
        ep_id: None,
        extra_pages: vec![],
        view_count: data.stat.as_ref().map(|s| s.view).unwrap_or(0),
        danmaku_count: data.stat.as_ref().map(|s| s.danmaku).unwrap_or(0),
        series_title: None,
    })
}

/// 通过番剧 season API 获取视频信息
/// API: https://api.bilibili.com/pgc/view/web/season?ep_id={ep_id} 或 ?season_id={season_id}
async fn try_bangumi_season_info(
    client: &Client,
    ep_id: Option<u64>,
    season_id: Option<u64>,
    credential: Option<&Credential>,
) -> Result<VideoInfo> {
    let mut request = client
        .get("https://api.bilibili.com/pgc/view/web/season")
        .header("Referer", REFERER);

    if let Some(ep) = ep_id {
        request = request.query(&[("ep_id", ep.to_string())]);
    } else if let Some(ss) = season_id {
        request = request.query(&[("season_id", ss.to_string())]);
    }

    if let Some(cred) = credential {
        request = request.header("Cookie", cred.cookie_header());
    }

    let resp = request.send().await?;
    let body_text = resp.text().await?;
    log::debug!(
        "[bangumi-season] ep_id={:?}, season_id={:?}, 响应: {}",
        ep_id,
        season_id,
        body_text.chars().take(500).collect::<String>()
    );

    let json: serde_json::Value = serde_json::from_str(&body_text)
        .context("番剧 season API 响应解析失败")?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "番剧 season API 失败: {}",
            json["message"].as_str().unwrap_or("未知错误")
        );
    }

    let result = json.get("result").context("番剧 season 响应无 result")?;
    let title = result["title"].as_str().unwrap_or("未知番剧").to_string();

    // result.episodes 是主列表，但可能混入预告（badge=预告, badge_type=1）
    let episodes = result["episodes"]
        .as_array()
        .context("番剧 season 响应无 episodes")?;

    // 正片 = badge_type != 1（排除预告）
    let main_episodes: Vec<&serde_json::Value> = episodes
        .iter()
        .filter(|ep| ep["badge_type"].as_i64().unwrap_or(0) != 1)
        .collect();

    // 预告/花絮 = result.episodes 中的预告 + result.section 所有内容
    let mut extra_episodes: Vec<serde_json::Value> = episodes
        .iter()
        .filter(|ep| ep["badge_type"].as_i64().unwrap_or(0) == 1)
        .cloned()
        .collect();
    if let Some(sections) = result.get("section").and_then(|s| s.as_array()) {
        for section in sections {
            if let Some(section_eps) = section.get("episodes").and_then(|e| e.as_array()) {
                extra_episodes.extend(section_eps.iter().cloned());
            }
        }
    }

    log::info!(
        "[bangumi-season] episodes={}, 正片={}, 额外={}",
        episodes.len(),
        main_episodes.len(),
        extra_episodes.len()
    );

    log::info!(
        "[bangumi-season] 正片 {} 集, 额外 {} 集",
        main_episodes.len(),
        extra_episodes.len()
    );

    let episodes_for_search = if main_episodes.is_empty() {
        // 兜底：如果没有正片则用额外内容
        extra_episodes.iter().collect()
    } else {
        main_episodes.clone()
    };

    // 在 episodes 中找匹配的 ep_id，找不到则用第一集
    let target_episode = ep_id.and_then(|eid| {
        episodes_for_search.iter().find(|ep| ep["id"].as_i64() == Some(eid as i64)).copied()
    });
    let episode = target_episode
        .or(episodes_for_search.first().copied())
        .context("番剧 episodes 为空")?;

    let ep_bvid = episode["bvid"].as_str().unwrap_or("").to_string();
    let ep_aid = episode["aid"].as_i64().unwrap_or(0) as u64;
    let ep_cid = episode["cid"].as_i64().unwrap_or(0);
    let ep_title = episode["title"].as_str().unwrap_or("").to_string();
    let ep_long_title = episode["long_title"].as_str().unwrap_or("").to_string();
    let ep_duration = episode["duration"]
        .as_i64()
        .unwrap_or(0) as u64
        / 1000; // API 返回毫秒

    // 构造显示标题
    let display_title = if ep_long_title.is_empty() {
        format!("{} 第{}话", title, ep_title)
    } else {
        format!("{} {} {}", title, ep_title, ep_long_title)
    };

    // 构造 PageInfo 的辅助闭包
    let make_page = |i: usize, ep: &serde_json::Value| PageInfo {
        cid: ep["cid"].as_i64().unwrap_or(0),
        page: (i + 1) as u32,
        part: {
            let t = ep["long_title"].as_str().unwrap_or("");
            if t.is_empty() {
                format!("第{}话", ep["title"].as_str().unwrap_or("?"))
            } else {
                format!("第{}话 {}", ep["title"].as_str().unwrap_or("?"), t)
            }
        },
        duration: ep["duration"].as_i64().unwrap_or(0) as u64 / 1000,
        bvid: Some(ep["bvid"].as_str().unwrap_or("").to_string()),
        ep_id: ep["id"].as_i64().map(|v| v as u64),
    };

    // 正片
    let pages: Vec<PageInfo> = main_episodes
        .iter()
        .enumerate()
        .map(|(i, ep)| make_page(i, ep))
        .collect();

    // 预告/花絮 — 直接用 result.section 的内容
    let extra_pages: Vec<PageInfo> = extra_episodes
        .iter()
        .enumerate()
        .map(|(i, ep)| make_page(i, ep))
        .collect();

    log::info!(
        "[bangumi-season] 解析成功: {} (正片{}集, 预告{}集), bvid={}, cid={}",
        title, pages.len(), extra_pages.len(), ep_bvid, ep_cid
    );

    Ok(VideoInfo {
        bvid: ep_bvid,
        aid: ep_aid,
        title: display_title,
        desc: result["evaluate"].as_str().unwrap_or("").to_string(),
        pic: http_to_https(result["cover"].as_str().unwrap_or("")),
        owner_mid: 0,
        owner_name: result["up_info"]["name"]
            .as_str()
            .unwrap_or("B站番剧")
            .to_string(),
        owner_face: http_to_https(
            result["up_info"]["avatar"]
                .as_str()
                .unwrap_or(""),
        ),
        duration: ep_duration,
        pages,
        ep_id,
        extra_pages,
        view_count: result["stat"]["views"].as_u64().unwrap_or(0),
        danmaku_count: result["stat"]["danmakus"].as_u64().unwrap_or(0),
        series_title: Some(title),
    })
}
