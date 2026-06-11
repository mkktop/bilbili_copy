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

/// 创建 HTTP 客户端
fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

/// 根据BV号/AV号/ep_id获取视频详细信息
pub async fn get_video_info(
    bvid: Option<&str>,
    aid: Option<u64>,
    ep_id: Option<u64>,
    credential: Option<&Credential>,
) -> Result<VideoInfo> {
    let client = bilibili_client()?;

    // 如果只有 ep_id，优先尝试番剧专用 season API
    if bvid.is_none() && aid.is_none() {
        if let Some(ep) = ep_id {
            log::info!("[video] 检测到 ep_id={}, 先尝试番剧 season API", ep);
            match try_bangumi_season_info(&client, ep, credential).await {
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

    let resp: BilibiliResponse<ViewData> = request.send().await?.json().await?;

    if resp.code != 0 {
        anyhow::bail!(
            "获取视频信息失败: {}",
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

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
    })
}

/// 通过番剧 season API 获取单集视频信息
/// API: https://api.bilibili.com/pgc/view/web/season?ep_id={ep_id}
async fn try_bangumi_season_info(
    client: &Client,
    ep_id: u64,
    credential: Option<&Credential>,
) -> Result<VideoInfo> {
    let mut request = client
        .get("https://api.bilibili.com/pgc/view/web/season")
        .header("Referer", REFERER)
        .query(&[("ep_id", ep_id.to_string())]);

    if let Some(cred) = credential {
        request = request.header("Cookie", cred.cookie_header());
    }

    let resp = request.send().await?;
    let body_text = resp.text().await?;
    log::debug!(
        "[bangumi-season] ep_id={}, 响应: {}",
        ep_id,
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

    // 在 episodes 数组中找到匹配的 ep_id
    let episodes = result["episodes"]
        .as_array()
        .context("番剧 season 响应无 episodes")?;

    let mut target_episode: Option<&serde_json::Value> = None;
    for ep in episodes {
        if ep["id"].as_i64() == Some(ep_id as i64) {
            target_episode = Some(ep);
            break;
        }
    }

    // 如果找不到精确匹配，用第一集
    let episode = target_episode
        .or(episodes.first())
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

    // 把所有剧集作为分P构造 pages
    let pages: Vec<PageInfo> = episodes
        .iter()
        .enumerate()
        .map(|(i, ep)| PageInfo {
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
        })
        .collect();

    log::info!(
        "[bangumi-season] 解析成功: {} ({}集), 当前 ep={}: bvid={}, cid={}",
        title, pages.len(), ep_id, ep_bvid, ep_cid
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
        ep_id: Some(ep_id),
    })
}
