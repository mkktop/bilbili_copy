use crate::bilibili::credential::Credential;
use crate::bilibili::wbi;
use crate::bilibili::{REFERER, PagedResult, VideoListItem, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// UP 主的合集/系列条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    /// season_id 或 series_id
    pub id: String,
    pub name: String,
    pub cover: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub total: i64,
    /// "season"（合集）或 "series"（列表）
    pub collection_type: String,
    pub mid: i64,
}

/// 用户订阅的合集/收藏夹条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribedCollection {
    pub id: String,
    pub name: String,
    pub cover: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub total: i64,
    /// "favorite"（收藏夹, type=11）或 "season"（合集, type=21）
    pub collection_type: String,
    #[serde(default)]
    pub upper_name: String,
    #[serde(default)]
    pub upper_mid: i64,
}

/// 从 meta JSON 对象提取合集/系列封面（cover 优先，回退 square_cover/horizontal_cover）
fn meta_cover(meta: &Value) -> String {
    meta["cover"]
        .as_str()
        .or_else(|| meta["square_cover"].as_str())
        .or_else(|| meta["horizontal_cover"].as_str())
        .unwrap_or("")
        .to_string()
}

/// 获取 UP 主的全部合集与系列列表（自动遍历分页）
/// API: GET https://api.bilibili.com/x/polymer/web-space/seasons_series_list
pub async fn get_upper_collections(mid: i64, credential: Option<&Credential>) -> Result<Vec<CollectionInfo>> {
    let client = api_client();
    let mut all = Vec::new();
    let mut total_count: i64 = 0;
    let page_size: i64 = 20;

    let mut page_num: u32 = 1;
    loop {
        let mut request = client
            .get("https://api.bilibili.com/x/polymer/web-space/seasons_series_list")
            .header("Referer", format!("https://space.bilibili.com/{}", mid))
            .query(&[
                ("mid", mid.to_string().as_str()),
                ("page_num", page_num.to_string().as_str()),
                ("page_size", page_size.to_string().as_str()),
                ("web_location", "333.1387"),
            ]);
        if let Some(cred) = credential {
            request = request.header("Cookie", cred.cookie_header());
        }

        let resp_text = request.send().await?.text().await?;
        let resp: Value = serde_json::from_str(&resp_text)
            .with_context(|| format!("合集列表响应解析失败, 第 {} 页", page_num))?;
        let code = resp["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            anyhow::bail!(
                "获取合集列表失败: {}",
                resp["message"].as_str().unwrap_or("未知错误")
            );
        }

        // items_lists 为 null 表示该 UP 主无合集或无权访问
        if resp["data"]["items_lists"].is_null() {
            break;
        }

        if page_num == 1 {
            total_count = resp["data"]["page"]["total"].as_i64().unwrap_or(0);
        }

        let mut page_items = Vec::new();

        // 合集 (seasons_list)
        if let Some(seasons) = resp["data"]["items_lists"]["seasons_list"].as_array() {
            for season in seasons {
                let meta = &season["meta"];
                page_items.push(CollectionInfo {
                    id: meta["season_id"]
                        .as_i64()
                        .map(|v| v.to_string())
                        .or_else(|| meta["season_id"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default(),
                    name: meta["name"].as_str().unwrap_or("").to_string(),
                    cover: http_to_https(&meta_cover(season)),
                    description: meta["description"].as_str().unwrap_or("").to_string(),
                    total: meta["total"].as_i64().unwrap_or(0),
                    collection_type: "season".into(),
                    mid,
                });
            }
        }

        // 列表 (series_list)
        if let Some(series) = resp["data"]["items_lists"]["series_list"].as_array() {
            for s in series {
                let meta = &s["meta"];
                page_items.push(CollectionInfo {
                    id: meta["series_id"]
                        .as_i64()
                        .map(|v| v.to_string())
                        .or_else(|| meta["series_id"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default(),
                    name: meta["name"].as_str().unwrap_or("").to_string(),
                    cover: http_to_https(&meta_cover(s)),
                    description: meta["description"].as_str().unwrap_or("").to_string(),
                    total: meta["total"].as_i64().unwrap_or(0),
                    collection_type: "series".into(),
                    mid,
                });
            }
        }

        if page_items.is_empty() {
            break;
        }
        all.extend(page_items);

        if total_count > 0 && all.len() >= total_count as usize {
            break;
        }
        page_num += 1;
        // 避免请求过于频繁
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    log::info!("[collection] UP {} 共 {} 个合集/系列", mid, all.len());
    Ok(all)
}

/// 获取合集(season)或列表(series)内的视频
/// API: GET https://api.bilibili.com/x/series/archives （series, WBI 签名）
///      GET https://api.bilibili.com/x/polymer/web-space/seasons_archives_list （season, WBI 签名）
pub async fn get_collection_videos(
    mid: i64,
    sid: &str,
    collection_type: &str,
    page: u32,
    credential: &Credential,
) -> Result<PagedResult<VideoListItem>> {
    let client = api_client();
    let mixin_key = wbi::get_mixin_key_cached(credential)
        .await
        .context("获取 WBI 签名密钥失败")?;

    // series 用 pn/ps，season 用 page_num/page_size
    let is_series = collection_type == "series";
    let (page_key, total_key) = if is_series {
        ("pn", "total")
    } else {
        ("page_num", "total")
    };

    let mut params: Vec<(String, String)> = if is_series {
        vec![
            ("mid".to_string(), mid.to_string()),
            ("series_id".to_string(), sid.to_string()),
            ("only_normal".to_string(), "true".to_string()),
            ("sort".to_string(), "desc".to_string()),
            (page_key.to_string(), page.to_string()),
            ("ps".to_string(), "30".to_string()),
        ]
    } else {
        vec![
            ("mid".to_string(), mid.to_string()),
            ("season_id".to_string(), sid.to_string()),
            (page_key.to_string(), page.to_string()),
            ("page_size".to_string(), "30".to_string()),
        ]
    };
    wbi::sign_params(&mut params, &mixin_key);

    let url = if is_series {
        "https://api.bilibili.com/x/series/archives"
    } else {
        "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list"
    };

    let resp_text = client
        .get(url)
        .header("Referer", format!("https://space.bilibili.com/{}", mid))
        .header("Cookie", credential.cookie_header())
        .query(&params)
        .send()
        .await?
        .text()
        .await?;

    log::debug!(
        "[collection] {} 视频响应: {}",
        collection_type,
        &resp_text[..resp_text.len().min(500)]
    );

    let resp: Value = serde_json::from_str(&resp_text).context("合集视频响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取合集视频失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }

    let total = resp["data"]["page"][total_key].as_i64().unwrap_or(0);
    let archives = resp["data"]["archives"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items: Vec<VideoListItem> = archives
        .into_iter()
        .map(|v| VideoListItem {
            bvid: v["bvid"].as_str().unwrap_or("").to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            cover: http_to_https(v["pic"].as_str().unwrap_or("")),
            upper_name: v["owner"]["name"].as_str().unwrap_or("").to_string(),
            upper_mid: v["owner"]["mid"].as_i64().unwrap_or(mid),
            duration: v["duration"].as_i64().unwrap_or(0),
            play: v["stat"]["view"].as_i64().unwrap_or(0),
            danmaku: v["stat"]["danmaku"].as_i64().unwrap_or(0),
            pubdate: v["pubdate"].as_i64().unwrap_or(0),
        })
        .collect();

    let page_size = 30i64;
    let has_more = total > (page as i64) * page_size;

    log::info!(
        "[collection] {} {} 第 {} 页: {} 个视频, total={}",
        collection_type,
        sid,
        page,
        items.len(),
        total
    );

    Ok(PagedResult {
        items,
        total,
        has_more,
        page,
    })
}

/// 获取当前用户订阅的合集与收藏夹列表（自动遍历分页）
/// API: GET https://api.bilibili.com/x/v3/fav/folder/collected/list
pub async fn get_subscribed_collections(credential: &Credential) -> Result<Vec<SubscribedCollection>> {
    let client = api_client();
    let uid = &credential.dedeuserid;
    let mut all = Vec::new();
    let page_size = 20;

    let mut page: u32 = 1;
    loop {
        let resp_text = client
            .get("https://api.bilibili.com/x/v3/fav/folder/collected/list")
            .header("Referer", REFERER)
            .header("Cookie", credential.cookie_header())
            .query(&[
                ("up_mid", uid.as_str()),
                ("pn", page.to_string().as_str()),
                ("ps", page_size.to_string().as_str()),
                ("platform", "web"),
            ])
            .send()
            .await?
            .text()
            .await?;

        let resp: Value =
            serde_json::from_str(&resp_text).context("订阅合集列表响应解析失败")?;
        let code = resp["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            anyhow::bail!(
                "获取订阅合集失败: {}",
                resp["message"].as_str().unwrap_or("未知错误")
            );
        }

        let list = match resp["data"]["list"].as_array() {
            Some(l) if !l.is_empty() => l,
            _ => break,
        };

        for item in list {
            // type=11 收藏夹，type=21 合集
            let item_type = item["type"].as_i64().unwrap_or(0);
            let collection_type = if item_type == 11 { "favorite" } else { "season" };
            all.push(SubscribedCollection {
                id: item["id"].as_i64().unwrap_or(0).to_string(),
                name: item["title"].as_str().unwrap_or("").to_string(),
                cover: http_to_https(item["cover"].as_str().unwrap_or("")),
                description: item["intro"].as_str().unwrap_or("").to_string(),
                total: item["media_count"].as_i64().unwrap_or(0),
                collection_type: collection_type.into(),
                upper_name: item["upper"]["name"].as_str().unwrap_or("").to_string(),
                upper_mid: item["upper"]["mid"].as_i64().unwrap_or(0),
            });
        }

        if list.len() < page_size as usize {
            break;
        }
        page += 1;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    log::info!("[collection] 订阅合集/收藏夹 {} 个", all.len());
    Ok(all)
}
