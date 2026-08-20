//! 订阅追更：用户收藏的 UP 合集/收藏夹，定时检查新增内容并自动入队下载。
//!
//! 语义：
//! - 添加订阅时立即抓取当前全量 bvid 作为基线（known_bvids），
//!   只追新内容、不回扫历史（历史内容请用批量下载）
//! - 每次检查拉全量列表 → diff 出新增 bvid → 走批量入队（含下载历史去重）
//! - 检查间隔由 settings.subscription_check_interval_min 控制（0 = 关闭），
//!   调度循环在 lib.rs setup 中启动；用户也可在 UI 手动触发单条检查

use serde::Serialize;
use std::collections::HashSet;
use tauri::{AppHandle, Manager, State};

use crate::bilibili::credential::Credential;
use crate::bilibili::video::get_video_info;
use crate::bilibili::{collection, favorite};
use crate::commands::batch::submit_video;
use crate::commands::settings::get_settings;
use crate::db::{self, DbState};

/// 单次检查的结果（serde snake_case）
#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionCheckResult {
    pub queued: usize,
    pub skipped: usize,
}

/// 订阅列表翻页保险丝：单条订阅的合集/收藏夹通常远小于该上限
const MAX_SUB_PAGES: u32 = 20;
/// 翻页请求间隔
const SUB_PAGE_DELAY_MS: u64 = 200;
/// 新增项逐个解析 cid 的间隔（与批量下载一致）
const BATCH_PARSE_DELAY_MS: u64 = 350;

/// 列出全部本地订阅（追更管理 UI）
#[tauri::command]
pub fn get_subscriptions(db: State<'_, DbState>) -> Result<Vec<db::SubscriptionEntry>, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::list_subscriptions(&conn).map_err(|e| e.to_string())
}

/// 添加订阅。立即抓取当前内容作基线（只追新不回扫），抓取失败则报错不入库。
#[tauri::command]
pub async fn add_subscription(
    kind: String,
    source_id: String,
    title: String,
    cover: String,
    upper_name: String,
    upper_mid: i64,
    db: State<'_, DbState>,
) -> Result<db::SubscriptionEntry, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    let sub = db::SubscriptionEntry {
        id: 0,
        kind,
        source_id,
        title,
        cover,
        upper_name,
        upper_mid,
        known_bvids: Vec::new(),
        last_check: None,
        created_at: String::new(),
    };

    // 基线抓取：失败则不入库（否则首次检查会把全部内容当新增批量下载）
    let fetched = fetch_subscription_bvids(&sub, &credential)
        .await
        .map_err(|e| format!("抓取订阅内容失败：{}", e))?;
    let baseline: Vec<String> = fetched.into_iter().map(|(b, _)| b).collect();

    let created = {
        let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        let mut entry = sub;
        entry.known_bvids = baseline;
        let id = db::insert_subscription(&conn, &entry).map_err(|e| e.to_string())?;
        entry.id = id;
        db::update_subscription_state(&conn, id, &entry.known_bvids)
            .map_err(|e| e.to_string())?;
        db::list_subscriptions(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == id)
            .unwrap_or(entry)
    };

    log::info!("[subscription] 添加订阅 {}#{}，基线 {} 条", created.kind, created.source_id, created.known_bvids.len());
    Ok(created)
}

/// 删除订阅（不影响已入队的下载任务）
#[tauri::command]
pub fn remove_subscription(id: i64, db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::delete_subscription(&conn, id).map_err(|e| e.to_string())
}

/// 手动触发单条订阅检查（UI「立即检查」按钮）
#[tauri::command]
pub async fn check_subscription(
    id: i64,
    app: AppHandle,
) -> Result<SubscriptionCheckResult, String> {
    let state = app.state::<DbState>();
    let sub = {
        let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        db::list_subscriptions(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "订阅不存在".to_string())?
    };
    run_subscription_check(app, &sub).await.map_err(|e| e.to_string())
}

/// 检查全部订阅（调度器周期调用；也可由 UI 调用）。
/// 单条失败不影响其它订阅，逐条顺序执行并带间隔。
pub async fn check_all_subscriptions(app: AppHandle) {
    let state = app.state::<DbState>();
    let subs = {
        let conn = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match db::list_subscriptions(&conn) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[subscription] 读取订阅列表失败: {}", e);
                return;
            }
        }
    };
    if subs.is_empty() {
        return;
    }
    log::info!("[subscription] 开始检查 {} 条订阅", subs.len());
    for (i, sub) in subs.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(SUB_PAGE_DELAY_MS)).await;
        }
        match run_subscription_check(app.clone(), sub).await {
            Ok(r) if r.queued > 0 => log::info!(
                "[subscription] {} 新增 {} 条已入队（跳过 {}）",
                sub.title, r.queued, r.skipped
            ),
            Ok(_) => {}
            Err(e) => log::warn!("[subscription] {} 检查失败: {}", sub.title, e),
        }
    }
}

/// 检查单个订阅：拉全量 → diff known → 新增项入队 → 更新 known/last_check。
async fn run_subscription_check(
    app: AppHandle,
    sub: &db::SubscriptionEntry,
) -> anyhow::Result<SubscriptionCheckResult> {
    let state = app.state::<DbState>();
    let credential = Credential::load()
        .map_err(|e| anyhow::anyhow!("读取登录信息失败: {}", e))?
        .ok_or_else(|| anyhow::anyhow!("请先登录"))?;

    // 1. 拉全量
    let all = fetch_subscription_bvids(sub, &credential).await?;
    let fresh: Vec<String> = all.iter().map(|(b, _)| b.clone()).collect();
    let known: HashSet<String> = sub.known_bvids.iter().cloned().collect();

    // 2. diff 新增
    let new_items: Vec<&(String, String)> = all.iter().filter(|(b, _)| !known.contains(b)).collect();
    if new_items.is_empty() {
        // 无新增也更新检查时间（UI 展示用）
        let conn = state.0.lock().unwrap_or_else(|p| p.into_inner());
        db::update_subscription_state(&conn, sub.id, &fresh)?;
        return Ok(SubscriptionCheckResult { queued: 0, skipped: 0 });
    }

    // 3. 新增项入队（复用批量下载逻辑：解析 cid + 下载历史去重）
    let settings = get_settings().map_err(|e| anyhow::anyhow!(e))?;
    let mut dedup = {
        let conn = state.0.lock().unwrap_or_else(|p| p.into_inner());
        db::build_download_dedup(&conn)?
    };
    let mut queued = 0usize;
    let mut skipped = 0usize;
    for (i, (bvid, _title_hint)) in new_items.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(BATCH_PARSE_DELAY_MS)).await;
        }
        let info = match get_video_info(Some(bvid.as_str()), None, None, None, None, Some(&credential)).await {
            Ok(info) => info,
            Err(e) => {
                log::warn!("[subscription] 解析新增视频失败 {}: {}", bvid, e);
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
        let title = if info.pages.len() > 1 {
            format!("P1 {}", page.part)
        } else {
            info.title.clone()
        };
        // 目录分组：订阅名（合集/收藏夹名），保持与手动批量下载的落盘布局一致
        let video_title = sub.title.clone();
        let video_meta = if settings.download_nfo {
            Some(crate::download_manager::VideoMeta {
                bvid: info.bvid.clone(),
                title: title.clone(),
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
            })
        } else {
            None
        };

        let submitted = {
            let conn = state.0.lock().unwrap_or_else(|p| p.into_inner());
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

    // 4. 基线更新为本次全量（含解析失败项——重试太频繁无意义，下轮再 diff）
    {
        let conn = state.0.lock().unwrap_or_else(|p| p.into_inner());
        db::update_subscription_state(&conn, sub.id, &fresh)?;
    }

    log::info!(
        "[subscription] {} 检查完成: 新增 {}, 入队 {}, 跳过 {}",
        sub.title, new_items.len(), queued, skipped
    );
    Ok(SubscriptionCheckResult { queued, skipped })
}

/// 拉取订阅源的全量内容（自动翻页），返回 (bvid, title) 列表（按源顺序）。
async fn fetch_subscription_bvids(
    sub: &db::SubscriptionEntry,
    credential: &Credential,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut all: Vec<(String, String)> = Vec::new();
    match sub.kind.as_str() {
        "favorite" => {
            let mut page = 1u32;
            loop {
                let res = favorite::get_favorite_videos(&sub.source_id, page, Some(credential)).await?;
                all.extend(
                    res.medias
                        .iter()
                        .filter(|m| !m.bvid.is_empty())
                        .map(|m| (m.bvid.clone(), m.title.clone())),
                );
                if !res.has_more || page >= MAX_SUB_PAGES {
                    break;
                }
                page += 1;
                tokio::time::sleep(std::time::Duration::from_millis(SUB_PAGE_DELAY_MS)).await;
            }
        }
        "season" | "series" => {
            let mut page = 1u32;
            loop {
                let res = collection::get_collection_videos(
                    sub.upper_mid, &sub.source_id, &sub.kind, page, credential,
                )
                .await?;
                all.extend(
                    res.items
                        .iter()
                        .filter(|i| !i.bvid.is_empty())
                        .map(|i| (i.bvid.clone(), i.title.clone())),
                );
                if !res.has_more || page >= MAX_SUB_PAGES {
                    break;
                }
                page += 1;
                tokio::time::sleep(std::time::Duration::from_millis(SUB_PAGE_DELAY_MS)).await;
            }
        }
        other => anyhow::bail!("未知订阅类型: {}", other),
    }
    Ok(all)
}
