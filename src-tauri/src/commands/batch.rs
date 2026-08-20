//! 批量下载：一次提交一组视频（收藏夹/合集/UP投稿/追番/每周必看等列表场景）。
//!
//! 与前端逐个 parse → download 的旧路径相比：
//! - 单次 IPC，后端控制解析节奏（防风控）
//! - 入队前按下载历史去重：done/queued/downloading/paused 自动跳过，
//!   error 记录复用原 id 重新提交（INSERT OR REPLACE 覆盖旧失败行）

use serde::Serialize;
use tauri::State;

use crate::bilibili::credential::Credential;
use crate::bilibili::video::{get_video_info, PageInfo};
use crate::commands::settings::get_settings;
use crate::db::{self, DbState};
use crate::download_manager::{manager, DownloadParams, SubmitOutcome, VideoMeta};

/// 批量提交结果（serde 自动 snake_case，与 TS 端 BatchDownloadResult 对应）
#[derive(Debug, Clone, Serialize)]
pub struct BatchDownloadResult {
    pub total: usize,
    pub queued: usize,
    pub skipped: usize,
}

/// 相邻两个视频 view 解析之间的间隔（防风控）
const BATCH_PARSE_DELAY_MS: u64 = 350;

/// 把单个视频入队（manager.submit + 下载历史落库）。返回 false = 去重跳过。
/// 提交成功后把 key 记入 skip，防止同批次内重复提交。
pub(crate) fn submit_video(
    conn: &rusqlite::Connection,
    dedup: &mut db::DownloadDedup,
    bvid: &str,
    cid: i64,
    title: &str,
    video_title: &str,
    ep_id: Option<u64>,
    duration: Option<u64>,
    pic: &str,
    owner_name: &str,
    video_meta: Option<VideoMeta>,
) -> bool {
    let key = format!("{}_{}", bvid, cid);
    if dedup.skip.contains(&key) {
        return false;
    }
    // error 记录复用原 id（覆盖旧失败行，恢复/重试语义一致）；否则用 bvid_cid 作新 id
    let id = dedup
        .reuse_id
        .get(&key)
        .cloned()
        .unwrap_or_else(|| key.clone());

    let entry = db::DownloadHistoryEntry {
        id: id.clone(),
        title: title.to_string(),
        bvid: bvid.to_string(),
        cid,
        ep_id,
        status: "queued".to_string(),
        progress: 0.0,
        phase: None,
        error_msg: None,
        output_path: None,
        pic: if pic.is_empty() { None } else { Some(pic.to_string()) },
        // 与前端 handleDownload 的 ISO 格式一致，保证 created_at 排序统一
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        quality: None,
        video_title: if video_title.is_empty() { None } else { Some(video_title.to_string()) },
        size: None,
        duration: duration.map(|d| d as i64),
        owner_name: if owner_name.is_empty() { None } else { Some(owner_name.to_string()) },
        subtitle_only: false,
        audio_only: false,
    };
    if let Err(e) = db::insert_download(conn, &entry) {
        log::warn!("[batch] 下载记录落库失败 ({}): {}", id, e);
    }

    let params = DownloadParams {
        id: id.clone(),
        bvid: bvid.to_string(),
        cid,
        title: title.to_string(),
        video_title: video_title.to_string(),
        qn: None,
        ep_id,
        duration,
        subtitle_only: false,
        audio_only: false,
        video_meta,
        owner_name: if owner_name.is_empty() { None } else { Some(owner_name.to_string()) },
    };
    let queued = matches!(manager().submit(params, 0), SubmitOutcome::Queued);
    if queued {
        dedup.skip.insert(key);
    }
    queued
}

/// 从 VideoInfo 构建 NFO 元数据快照（仅当设置开启 NFO 时由调用方传入）
fn build_video_meta(info: &crate::bilibili::video::VideoInfo, title: &str, page: &PageInfo) -> VideoMeta {
    VideoMeta {
        bvid: info.bvid.clone(),
        title: title.to_string(),
        desc: info.desc.clone(),
        pic: info.pic.clone(),
        owner_mid: info.owner_mid,
        owner_name: info.owner_name.clone(),
        owner_face: info.owner_face.clone(),
        duration: page.duration,
        pubdate: info.pubdate,
        view_count: info.view_count,
        like_count: info.like_count,
        danmaku_count: info.danmaku_count,
        tags: info.tags.clone(),
    }
}

/// 批量下载一组 BV 号。每个视频解析第一个分P 的 cid 后入队；
/// 解析失败或去重命中的计入 skipped。
///
/// @param bvids BV 号列表
/// @param folder 下载目录分组名（如合集名）；None 时按各视频自身标题分组（与详情页单下载一致）
#[tauri::command]
pub async fn batch_download_bvids(
    bvids: Vec<String>,
    folder: Option<String>,
    db: State<'_, DbState>,
) -> Result<BatchDownloadResult, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;
    let settings = get_settings().map_err(|e| e.to_string())?;

    let mut dedup = {
        let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        db::build_download_dedup(&conn).map_err(|e| e.to_string())?
    };

    let total = bvids.len();
    let mut queued = 0usize;
    let mut skipped = 0usize;

    for (i, bvid) in bvids.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(BATCH_PARSE_DELAY_MS)).await;
        }
        let info = match get_video_info(Some(bvid), None, None, None, None, Some(&credential)).await {
            Ok(info) => info,
            Err(e) => {
                log::warn!("[batch] 解析失败，跳过 {}: {}", bvid, e);
                skipped += 1;
                continue;
            }
        };
        let page = match info.pages.first() {
            Some(p) => p.clone(),
            None => {
                skipped += 1;
                continue;
            }
        };
        // 批量场景只下 P1；多分P 视频标题加 P1 前缀与详情页行为一致
        let title = if info.pages.len() > 1 {
            format!("P1 {}", page.part)
        } else {
            info.title.clone()
        };
        let video_title = folder
            .clone()
            .unwrap_or_else(|| info.series_title.clone().unwrap_or_else(|| info.title.clone()));
        let video_meta = if settings.download_nfo {
            Some(build_video_meta(&info, &title, &page))
        } else {
            None
        };

        let submitted = {
            let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
            submit_video(
                &conn, &mut dedup, bvid, page.cid, &title, &video_title, None,
                Some(page.duration), &info.pic, &info.owner_name, video_meta,
            )
        };
        if submitted {
            queued += 1;
        } else {
            skipped += 1;
        }
    }

    log::info!("[batch] bvids 批量提交完成: 共 {}, 入队 {}, 跳过 {}", total, queued, skipped);
    Ok(BatchDownloadResult { total, queued, skipped })
}

/// 批量下载整部番剧/追剧（按 season_id 解析全部正片，每集独立入队）。
/// 无逐集网络请求（season 一次解析拿全），入队无需节奏控制。
#[tauri::command]
pub async fn batch_download_season(
    season_id: u64,
    db: State<'_, DbState>,
) -> Result<BatchDownloadResult, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;
    let settings = get_settings().map_err(|e| e.to_string())?;

    let info = get_video_info(None, None, None, Some(season_id), None, Some(&credential))
        .await
        .map_err(|e| e.to_string())?;

    let mut dedup = {
        let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        db::build_download_dedup(&conn).map_err(|e| e.to_string())?
    };

    // 分组名：整季共用（番剧=series_title，回退 title）
    let folder = info
        .series_title
        .clone()
        .unwrap_or_else(|| info.title.clone());

    let total = info.pages.len();
    let mut queued = 0usize;
    let mut skipped = 0usize;

    for page in &info.pages {
        let ep_bvid = page.bvid.clone().unwrap_or_else(|| info.bvid.clone());
        let title = page.part.clone();
        let video_meta = if settings.download_nfo {
            Some(build_video_meta(&info, &title, page))
        } else {
            None
        };

        let submitted = {
            let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
            submit_video(
                &conn, &mut dedup, &ep_bvid, page.cid, &title, &folder, page.ep_id,
                Some(page.duration), &info.pic, &info.owner_name, video_meta,
            )
        };
        if submitted {
            queued += 1;
        } else {
            skipped += 1;
        }
    }

    log::info!(
        "[batch] season {} 批量提交完成: 共 {} 集, 入队 {}, 跳过 {}",
        season_id, total, queued, skipped
    );
    Ok(BatchDownloadResult { total, queued, skipped })
}
