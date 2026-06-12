use crate::bilibili::credential::Credential;
use crate::bilibili::{BilibiliResponse, REFERER, USER_AGENT, http_to_https};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

// ==================== 公开类型 ====================

/// 收藏夹基本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteFolder {
    pub id: i64,
    pub title: String,
    pub media_count: u32,
}

/// 收藏夹内的单个视频
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteMedia {
    pub id: i64,
    pub title: String,
    pub bvid: String,
    pub cover: String,
    pub upper_name: String,
    pub upper_mid: i64,
    pub duration: Option<i64>,
    pub fav_time: i64,
    #[serde(default)]
    pub play: u64,
    #[serde(default)]
    pub like: u64,
}

/// 收藏夹视频分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteListResult {
    pub medias: Vec<FavoriteMedia>,
    pub total: u32,
    pub has_more: bool,
    pub page: u32,
}

// ==================== 内部 API 响应结构 ====================

#[derive(Debug, Deserialize)]
struct FavFolderRaw {
    id: i64,
    title: String,
    media_count: u32,
}

#[derive(Debug, Deserialize)]
struct FavFolderListData {
    #[serde(default)]
    list: Vec<FavFolderRaw>,
}

#[derive(Debug, Deserialize)]
struct FavUpperRaw {
    mid: i64,
    name: String,
    #[allow(dead_code)]
    face: String,
}

#[derive(Debug, Deserialize)]
struct FavMediaRaw {
    id: i64,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    vtype: i32,
    title: String,
    bvid: String,
    cover: String,
    #[allow(dead_code)]
    intro: String,
    upper: FavUpperRaw,
    duration: Option<i64>,
    fav_time: i64,
    #[allow(dead_code)]
    ctime: i64,
    #[allow(dead_code)]
    pubtime: i64,
    #[allow(dead_code)]
    attr: i32,
    #[serde(default)]
    cnt_info: Option<CntInfoRaw>,
}

#[derive(Debug, Deserialize)]
struct CntInfoRaw {
    #[serde(default)]
    play: u64,
    #[serde(default)]
    like: u64,
}

#[derive(Debug, Deserialize)]
struct FavResourceInfo {
    media_count: u32,
}

#[derive(Debug, Deserialize)]
struct FavResourceData {
    info: FavResourceInfo,
    medias: Option<Vec<FavMediaRaw>>,
    has_more: bool,
}

// ==================== HTTP 客户端 ====================

fn bilibili_client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建 HTTP 客户端失败")
}

// ==================== 公开 API 函数 ====================

/// 获取当前用户创建的收藏夹列表
/// API: GET https://api.bilibili.com/x/v3/fav/folder/created/list-all
pub async fn get_user_favorite_folders(credential: &Credential) -> Result<Vec<FavoriteFolder>> {
    let client = bilibili_client()?;

    let uid = &credential.dedeuserid;
    let resp_text = client
        .get("https://api.bilibili.com/x/v3/fav/folder/created/list-all")
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .query(&[("up_mid", uid.as_str())])
        .send()
        .await?
        .text()
        .await?;

    log::debug!("[favorite] created/list-all 响应: {}", &resp_text[..resp_text.len().min(500)]);

    let resp: BilibiliResponse<FavFolderListData> = serde_json::from_str(&resp_text)
        .context("收藏夹列表反序列化失败")?;

    if resp.code != 0 {
        anyhow::bail!(
            "获取收藏夹列表失败: {}",
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

    let folders: Vec<FavoriteFolder> = resp
        .data
        .map(|d| d.list)
        .unwrap_or_default()
        .into_iter()
        .map(|f| FavoriteFolder {
            id: f.id,
            title: f.title,
            media_count: f.media_count,
        })
        .collect();

    log::info!("[favorite] 获取到 {} 个收藏夹", folders.len());
    Ok(folders)
}

/// 分页获取收藏夹内的视频列表
/// API: GET https://api.bilibili.com/x/v3/fav/resource/list
pub async fn get_favorite_videos(
    media_id: &str,
    page: u32,
    credential: Option<&Credential>,
) -> Result<FavoriteListResult> {
    let client = bilibili_client()?;

    let mut request = client
        .get("https://api.bilibili.com/x/v3/fav/resource/list")
        .header("Referer", REFERER)
        .query(&[
            ("media_id", media_id),
            ("pn", &page.to_string()),
            ("ps", "20"),
            ("order", "mtime"),
            ("type", "0"),
            ("tid", "0"),
        ]);

    if let Some(cred) = credential {
        request = request.header("Cookie", cred.cookie_header());
    }

    let resp_text = request
        .send()
        .await?
        .text()
        .await?;

    log::debug!("[favorite] resource/list 响应: {}", &resp_text[..resp_text.len().min(500)]);

    let resp: BilibiliResponse<FavResourceData> = serde_json::from_str(&resp_text)
        .context("收藏夹视频列表反序列化失败")?;

    if resp.code != 0 {
        anyhow::bail!(
            "获取收藏夹视频失败: {}",
            resp.message.unwrap_or_else(|| "未知错误".to_string())
        );
    }

    let data = resp.data.context("收藏夹视频响应无 data")?;
    let total = data.info.media_count;

    let medias: Vec<FavoriteMedia> = data
        .medias
        .unwrap_or_default()
        .into_iter()
        .map(|m| FavoriteMedia {
            id: m.id,
            title: m.title,
            bvid: m.bvid,
            cover: http_to_https(&m.cover),
            upper_name: m.upper.name,
            upper_mid: m.upper.mid,
            duration: m.duration,
            fav_time: m.fav_time,
            play: m.cnt_info.as_ref().map(|c| c.play).unwrap_or(0),
            like: m.cnt_info.as_ref().map(|c| c.like).unwrap_or(0),
        })
        .collect();

    log::info!(
        "[favorite] 收藏夹 {} 第 {} 页: {} 个视频, has_more={}, total={}",
        media_id,
        page,
        medias.len(),
        data.has_more,
        total
    );

    Ok(FavoriteListResult {
        medias,
        total,
        has_more: data.has_more,
        page,
    })
}
