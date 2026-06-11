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

/// 根据BV号获取视频详细信息
pub async fn get_video_info(
    bvid: Option<&str>,
    aid: Option<u64>,
    credential: Option<&Credential>,
) -> Result<VideoInfo> {
    let client = bilibili_client()?;

    let mut request = client
        .get("https://api.bilibili.com/x/web-interface/view")
        .header("Referer", REFERER);

    // 优先使用 bvid，否则使用 aid
    if let Some(bvid) = bvid {
        request = request.query(&[("bvid", bvid)]);
    } else if let Some(aid) = aid {
        request = request.query(&[("aid", &aid.to_string())]);
    } else {
        anyhow::bail!("必须提供 bvid 或 aid");
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
    })
}
