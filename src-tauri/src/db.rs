use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Tauri managed state: 包装 SQLite 连接
pub struct DbState(pub Mutex<Connection>);

/// 数据库文件路径（exe 同目录下的 data.db）
pub fn db_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("data.db")
}

/// schema 版本号。
/// - 100：v1.0.0 断代基线（与 0.x 不兼容，版本不匹配整库重建）
/// - 101：download_history 新增 subtitle_only / audio_only 列（100 → 101 走
///   ALTER TABLE 增量迁移**保留用户数据**；更老的库（0.x / 全新空库）仍整库重建）
/// - 102：新增 subscriptions 表（订阅追更；CREATE IF NOT EXISTS 即可，无列变更）
const SCHEMA_VERSION: i64 = 102;

/// 初始化数据库：建表 + WAL + 版本校验（不匹配则重建）+ 清理残留
pub fn init_db() -> anyhow::Result<DbState> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(SCHEMA_SQL)?;

    // 1.0 断代：schema_version 不匹配（0.x 旧库 / 全新库 / 未来降级）时整库重建。
    // 全新库 version=0 也走此路径（drop 空表重建 + 记版本），逻辑统一。
    let version = current_schema_version(&conn);
    if version != SCHEMA_VERSION {
        if version == 100 {
            migrate_100_to_101(&conn)?;
            migrate_101_to_102(&conn)?;
        } else if version == 101 {
            migrate_101_to_102(&conn)?;
        } else {
            if version > 0 {
                log::warn!(
                    "[db] 检测到旧版数据库(schema_version={})，1.0 不兼容旧数据结构，重建数据库",
                    version
                );
            }
            rebuild_db(&conn)?;
        }
    }

    // 应用异常退出后残留的 downloading 任务改为 paused（而非 error），
    // 让用户可在「下载列表」手动恢复（复用 .tmp 续传）。临时文件由指纹机制保护，
    // 不匹配时 download_stream 会自动丢弃重下，不会损坏。
    conn.execute(
        "UPDATE download_history SET status='paused' WHERE status IN ('downloading', 'queued')",
        [],
    )?;

    log::info!("[db] 数据库初始化完成: {:?}", db_path());
    Ok(DbState(Mutex::new(conn)))
}

/// 100 → 101 增量迁移：补 subtitle_only / audio_only 两列，保留全部用户数据。
fn migrate_100_to_101(conn: &Connection) -> anyhow::Result<()> {
    log::info!("[db] 迁移 schema 100→101：download_history 增加 subtitle_only/audio_only 列（保留数据）");
    if !column_exists(conn, "download_history", "subtitle_only") {
        conn.execute(
            "ALTER TABLE download_history ADD COLUMN subtitle_only INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(conn, "download_history", "audio_only") {
        conn.execute(
            "ALTER TABLE download_history ADD COLUMN audio_only INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    set_schema_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// 101 → 102 增量迁移：创建 subscriptions 表（订阅追更）。纯新增表，无列变更。
fn migrate_101_to_102(conn: &Connection) -> anyhow::Result<()> {
    log::info!("[db] 迁移 schema 101→102：创建 subscriptions 表（订阅追更）");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            title TEXT NOT NULL,
            cover TEXT NOT NULL DEFAULT '',
            upper_name TEXT NOT NULL DEFAULT '',
            upper_mid INTEGER NOT NULL DEFAULT 0,
            known_bvids TEXT NOT NULL DEFAULT '[]',
            last_check TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_kind_source ON subscriptions(kind, source_id);",
    )?;
    set_schema_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// 判断表里是否已有某列（表/列名均为代码内硬编码字面量，无注入面）
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!(
        "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = '{}'",
        table, column
    );
    conn.query_row(&sql, [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        > 0
}

/// 整库重建：drop 全部表 → 按最新 SCHEMA_SQL 建表 → 记录当前版本。
/// 1.0 断代策略：不兼容旧数据，解析/下载历史、播放进度、搜索历史全部重置。
fn rebuild_db(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS parse_history;
         DROP TABLE IF EXISTS download_history;
         DROP TABLE IF EXISTS download_stats;
         DROP TABLE IF EXISTS play_progress;
         DROP TABLE IF EXISTS search_history;
         DROP TABLE IF EXISTS subscriptions;
         DROP TABLE IF EXISTS schema_version;",
    )?;
    conn.execute_batch(SCHEMA_SQL)?;
    set_schema_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// 读取 schema_version 表中的当前版本（空表视为 0）
fn current_schema_version(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))
        .unwrap_or(0)
}

/// 记录已升级到的版本号
fn set_schema_version(conn: &Connection, version: i64) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO schema_version (version) VALUES (?1)",
        params![version],
    )?;
    Ok(())
}

// ==================== 类型定义 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseHistoryEntry {
    pub id: String,
    pub url: String,
    pub bvid: String,
    pub title: String,
    pub video_info: serde_json::Value,
    pub parsed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadHistoryEntry {
    pub id: String,
    pub title: String,
    pub bvid: String,
    pub cid: i64,
    pub ep_id: Option<u64>,
    pub status: String,
    pub progress: f64,
    pub phase: Option<String>,
    pub error_msg: Option<String>,
    pub output_path: Option<String>,
    /// 视频封面 URL（v2 schema 新增，旧记录为 None）
    pub pic: Option<String>,
    pub created_at: String,
    /// 画质（v3 schema 新增）：恢复下载时作为 qn 参数，保证跨会话续传指纹匹配。旧记录为 None。
    #[serde(default)]
    pub quality: Option<i64>,
    /// 合集名/视频名（v3 schema 新增）：用于恢复时重建下载目录路径。旧记录为 None。
    #[serde(default)]
    pub video_title: Option<String>,
    /// 最终文件字节数（v4 schema 新增）：下载完成时落库，用于统计总大小。旧记录/未完成为 None。
    #[serde(default)]
    pub size: Option<i64>,
    /// 视频时长（秒，v4 schema 新增）：提交下载时写入，用于统计总时长。旧记录/未知为 None。
    #[serde(default)]
    pub duration: Option<i64>,
    /// UP 主名（v6 schema 新增）：文件名模板 {up} 占位符用，恢复/重试时重建输出路径。旧记录为 None。
    #[serde(default)]
    pub owner_name: Option<String>,
    /// 字幕库模式（101 schema 新增）：恢复/重试时按同模式重新提交，避免变成下整视频。旧记录 false。
    #[serde(default)]
    pub subtitle_only: bool,
    /// 仅音频模式（101 schema 新增）：同上。旧记录 false。
    #[serde(default)]
    pub audio_only: bool,
}

// ==================== CRUD ====================

// ---- Parse History ----

pub fn insert_parse(conn: &Connection, entry: &ParseHistoryEntry) -> anyhow::Result<()> {
    // 按 bvid 去重：已存在则更新（刷新时间移到顶部），否则插入新记录。
    // 用事务包裹 UPDATE-then-INSERT，避免并发解析同一 bvid 时两次调用都看到 updated==0 而插入重复行。
    let tx = conn.unchecked_transaction()?;
    let updated = tx.execute(
        "UPDATE parse_history SET title = ?1, video_info = ?2, parsed_at = ?3, url = ?4 WHERE bvid = ?5",
        params![entry.title, entry.video_info.to_string(), entry.parsed_at, entry.url, entry.bvid],
    )?;
    if updated == 0 {
        tx.execute(
            "INSERT INTO parse_history (id, url, bvid, title, video_info, parsed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.id, entry.url, entry.bvid, entry.title, entry.video_info.to_string(), entry.parsed_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_all_parses(conn: &Connection, limit: u32, offset: u32) -> anyhow::Result<Vec<ParseHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, url, bvid, title, video_info, parsed_at FROM parse_history ORDER BY parsed_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], |row| {
        let video_info_str: String = row.get(4)?;
        let video_info: serde_json::Value = serde_json::from_str(&video_info_str).unwrap_or(serde_json::Value::Null);
        Ok(ParseHistoryEntry {
            id: row.get(0)?,
            url: row.get(1)?,
            bvid: row.get(2)?,
            title: row.get(3)?,
            video_info,
            parsed_at: row.get(5)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn count_parses(conn: &Connection) -> anyhow::Result<u32> {
    let count: u32 = conn.query_row("SELECT COUNT(*) FROM parse_history", [], |r| r.get(0))?;
    Ok(count)
}

pub fn delete_parse(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM parse_history WHERE id = ?1", params![id])?;
    Ok(())
}

/// 更新解析记录的 parsed_at 为当前时间（点击查看时置顶）
pub fn touch_parse(conn: &Connection, bvid: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE parse_history SET parsed_at = datetime('now') WHERE bvid = ?1",
        params![bvid],
    )?;
    Ok(())
}

pub fn clear_all_parses(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM parse_history", [])?;
    Ok(())
}

// ---- Download History ----

pub fn insert_download(conn: &Connection, entry: &DownloadHistoryEntry) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO download_history (id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic, quality, video_title, size, duration, owner_name, subtitle_only, audio_only) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![entry.id, entry.title, entry.bvid, entry.cid, entry.ep_id, entry.status, entry.progress, entry.phase, entry.error_msg, entry.output_path, entry.pic, entry.quality, entry.video_title, entry.size, entry.duration, entry.owner_name, entry.subtitle_only, entry.audio_only],
    )?;
    Ok(())
}

pub fn update_download(
    conn: &Connection,
    id: &str,
    status: &str,
    progress: Option<f64>,
    phase: Option<&str>,
    error_msg: Option<&str>,
    output_path: Option<&str>,
    size: Option<i64>,
) -> anyhow::Result<()> {
    conn.execute(
        // error_msg：done 时显式清空——error→重试→done 的记录若保留旧错误，
        // 重启后前端恢复 errorMsg，已完成行会显示旧的红色"下载失败"文案。
        "UPDATE download_history SET status = ?1, progress = COALESCE(?2, progress), phase = COALESCE(?3, phase), error_msg = CASE WHEN ?1 = 'done' THEN NULL ELSE COALESCE(?4, error_msg) END, output_path = COALESCE(?5, output_path), size = COALESCE(?6, size) WHERE id = ?7",
        params![status, progress, phase, error_msg, output_path, size, id],
    )?;
    Ok(())
}

/// 读取一行下载记录的 status / size / duration（完成判定与累加统计用）。
/// 行不存在时返回 None。
pub fn get_download_row_status(
    conn: &Connection,
    id: &str,
) -> anyhow::Result<Option<(String, Option<i64>, Option<i64>)>> {
    let row = conn.query_row(
        "SELECT status, size, duration FROM download_history WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, Option<i64>>(2)?)),
    );
    match row {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 按状态过滤的下载历史查询（status=None 为全部；下载库视图的状态标签页）
pub fn get_downloads_filtered(conn: &Connection, status: Option<&str>, limit: u32, offset: u32) -> anyhow::Result<Vec<DownloadHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic, created_at, quality, video_title, size, duration, owner_name, subtitle_only, audio_only FROM download_history \
         WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![status, limit, offset], |row| {
        Ok(DownloadHistoryEntry {
            id: row.get(0)?,
            title: row.get(1)?,
            bvid: row.get(2)?,
            cid: row.get(3)?,
            ep_id: row.get(4)?,
            status: row.get(5)?,
            progress: row.get(6)?,
            phase: row.get(7)?,
            error_msg: row.get(8)?,
            output_path: row.get(9)?,
            pic: row.get(10)?,
            created_at: row.get(11)?,
            quality: row.get(12)?,
            video_title: row.get(13)?,
            size: row.get(14)?,
            duration: row.get(15)?,
            owner_name: row.get(16)?,
            subtitle_only: row.get::<_, i64>(17)? != 0,
            audio_only: row.get::<_, i64>(18)? != 0,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 按状态过滤的下载总数（status=None 为全部）
pub fn count_downloads_filtered(conn: &Connection, status: Option<&str>) -> anyhow::Result<u32> {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM download_history WHERE (?1 IS NULL OR status = ?1)",
        params![status],
        |r| r.get(0),
    )?;
    Ok(count)
}

/// 下载统计聚合（供统计面板使用）。
/// done_count/done_size/done_duration 来自 download_stats 累加器（单行 id=1），
/// 与 download_history 解耦——删除/清空下载历史不影响累计值。
/// total_count 为当前 download_history 记录数（与下载列表分页计数一致）。
#[derive(Debug, Clone, Serialize)]
pub struct DownloadStats {
    /// 当前下载记录数（含未完成，对应列表总数）
    pub total_count: u32,
    /// 累计已完成下载次数（累加器，删除列表项不回退）
    pub done_count: u32,
    /// 累计已完成下载总字节数（累加器）
    pub done_size: u64,
    /// 累计已完成下载总时长（秒，累加器）
    pub done_duration: u64,
}

/// 读取统计：total_count 取实时记录数，done_* 取累加器。
/// 累加器行不存在时（理论上不会发生，迁移已创建）返回 0。
pub fn download_stats(conn: &Connection) -> anyhow::Result<DownloadStats> {
    let total_count: u32 =
        conn.query_row("SELECT COUNT(*) FROM download_history", [], |r| r.get(0))?;
    let (done_count, done_size, done_duration): (u32, u64, u64) = conn
        .query_row(
            "SELECT done_count, done_size, done_duration FROM download_stats WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((0, 0, 0));
    Ok(DownloadStats {
        total_count,
        done_count,
        done_size,
        done_duration,
    })
}

/// 下载完成时累加统计（done_count += 1，size/duration 累加）。
/// 幂等前提：仅在状态真正转为 done 时由上层调用一次，不在此处去重。
pub fn increment_download_stats(
    conn: &Connection,
    size: u64,
    duration: u64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO download_stats (id, done_count, done_size, done_duration) VALUES (1, 1, ?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET \
            done_count = done_count + 1, \
            done_size = done_size + ?1, \
            done_duration = done_duration + ?2",
        params![size, duration],
    )?;
    Ok(())
}

/// 查询单条下载记录的 output_path（删除文件用）；记录不存在返回 None
pub fn get_download_output_path(conn: &Connection, id: &str) -> anyhow::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    let path: Option<String> = conn
        .query_row(
            "SELECT output_path FROM download_history WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(path)
}

pub fn delete_download(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM download_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_all_downloads(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM download_history", [])?;
    Ok(())
}

// ---- Play Progress ----

/// 保存/更新播放进度（cid 主键 upsert）
pub fn upsert_play_progress(
    conn: &Connection,
    cid: i64,
    bvid: &str,
    position: f64,
    duration: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO play_progress (cid, bvid, position, duration, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now')) \
         ON CONFLICT(cid) DO UPDATE SET position = ?3, duration = ?4, updated_at = datetime('now')",
        params![cid, bvid, position, duration],
    )?;
    // 轻量容量控制：只保留最近 500 条，更早的进度记录淡出（避免无限增长）
    conn.execute(
        "DELETE FROM play_progress WHERE cid NOT IN (SELECT cid FROM play_progress ORDER BY updated_at DESC LIMIT 500)",
        [],
    )?;
    Ok(())
}

/// 读取播放进度（秒），无记录返回 None
pub fn get_play_progress(conn: &Connection, cid: i64) -> anyhow::Result<Option<f64>> {
    let row = conn.query_row(
        "SELECT position FROM play_progress WHERE cid = ?1",
        params![cid],
        |r| r.get::<_, f64>(0),
    );
    match row {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 删除播放进度（看完时清除，下次从头播）
pub fn delete_play_progress(conn: &Connection, cid: i64) -> anyhow::Result<()> {
    conn.execute("DELETE FROM play_progress WHERE cid = ?1", params![cid])?;
    Ok(())
}

// ---- Subscriptions（订阅追更） ----

/// 订阅条目（本地追更：UP 合集 season/series 或收藏夹）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionEntry {
    pub id: i64,
    /// "season"/"series"（UP 合集/列表）或 "favorite"（收藏夹）
    pub kind: String,
    /// season_id/series_id 或收藏夹 media_id
    pub source_id: String,
    pub title: String,
    pub cover: String,
    pub upper_name: String,
    /// 合集所属 UP 的 mid（收藏夹为 0；season/series 检查时作查询参数）
    pub upper_mid: i64,
    /// 上次检查时已知的全部 bvid（JSON 数组；新检查 diff 出新增项）
    pub known_bvids: Vec<String>,
    /// 上次检查时间（datetime 文本；None = 尚未检查过）
    pub last_check: Option<String>,
    pub created_at: String,
}

/// 新增订阅（kind+source_id 唯一，重复添加返回 Err）
pub fn insert_subscription(conn: &Connection, sub: &SubscriptionEntry) -> anyhow::Result<i64> {
    let dup: i64 = conn.query_row(
        "SELECT COUNT(*) FROM subscriptions WHERE kind = ?1 AND source_id = ?2",
        params![sub.kind, sub.source_id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(dup == 0, "已订阅过该内容");
    conn.execute(
        "INSERT INTO subscriptions (kind, source_id, title, cover, upper_name, upper_mid, known_bvids) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![sub.kind, sub.source_id, sub.title, sub.cover, sub.upper_name, sub.upper_mid, serde_json::to_string(&sub.known_bvids)?],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 列出全部订阅
pub fn list_subscriptions(conn: &Connection) -> anyhow::Result<Vec<SubscriptionEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, source_id, title, cover, upper_name, upper_mid, known_bvids, last_check, created_at FROM subscriptions ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let known: String = row.get(7)?;
        Ok(SubscriptionEntry {
            id: row.get(0)?,
            kind: row.get(1)?,
            source_id: row.get(2)?,
            title: row.get(3)?,
            cover: row.get(4)?,
            upper_name: row.get(5)?,
            upper_mid: row.get(6)?,
            known_bvids: serde_json::from_str(&known).unwrap_or_default(),
            last_check: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 删除订阅
pub fn delete_subscription(conn: &Connection, id: i64) -> anyhow::Result<()> {
    conn.execute("DELETE FROM subscriptions WHERE id = ?1", params![id])?;
    Ok(())
}

/// 更新订阅的已知 bvid 集合与检查时间
pub fn update_subscription_state(
    conn: &Connection,
    id: i64,
    known_bvids: &[String],
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE subscriptions SET known_bvids = ?1, last_check = datetime('now') WHERE id = ?2",
        params![serde_json::to_string(known_bvids)?, id],
    )?;
    Ok(())
}

// ---- 批量下载去重辅助 ----

/// 批量提交前的下载历史快照：
/// - `skip`：bvid+cid 已存在且状态非 error 的记录（done/queued/downloading/paused → 跳过）
/// - `reuse_id`：状态为 error 的记录（重新提交复用其 id，INSERT OR REPLACE 覆盖旧失败行）
#[derive(Default)]
pub struct DownloadDedup {
    pub skip: std::collections::HashSet<String>,
    pub reuse_id: std::collections::HashMap<String, String>,
}

/// 构建全量去重快照（一次查询；批量入队时逐条比对，避免每项一次锁+查询）
pub fn build_download_dedup(conn: &Connection) -> anyhow::Result<DownloadDedup> {
    let mut stmt = conn.prepare("SELECT bvid, cid, status, id FROM download_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut dedup = DownloadDedup::default();
    for r in rows.filter_map(|r| r.ok()) {
        let (bvid, cid, status, id) = r;
        let key = format!("{}_{}", bvid, cid);
        if status == "error" {
            dedup.reuse_id.insert(key, id);
        } else {
            dedup.skip.insert(key);
        }
    }
    Ok(dedup)
}

// ---- Search History ----

/// 保存搜索关键词（keyword 主键 upsert：重复搜索只刷新时间置顶），容量控制保留最近 50 条
pub fn upsert_search_keyword(conn: &Connection, keyword: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO search_history (keyword, searched_at) VALUES (?1, datetime('now')) \
         ON CONFLICT(keyword) DO UPDATE SET searched_at = datetime('now')",
        params![keyword],
    )?;
    conn.execute(
        "DELETE FROM search_history WHERE keyword NOT IN (SELECT keyword FROM search_history ORDER BY searched_at DESC LIMIT 50)",
        [],
    )?;
    Ok(())
}

/// 读取最近搜索词（按时间降序，最多 limit 条）
pub fn get_search_keywords(conn: &Connection, limit: u32) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT keyword FROM search_history ORDER BY searched_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 删除单条搜索词
pub fn delete_search_keyword(conn: &Connection, keyword: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM search_history WHERE keyword = ?1", params![keyword])?;
    Ok(())
}

/// 清空搜索历史
pub fn clear_search_keywords(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM search_history", [])?;
    Ok(())
}

// ==================== Schema SQL ====================

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS parse_history (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    bvid TEXT NOT NULL,
    title TEXT NOT NULL,
    video_info TEXT NOT NULL,
    parsed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_history (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    ep_id INTEGER,
    status TEXT NOT NULL DEFAULT 'downloading',
    progress REAL NOT NULL DEFAULT 0.0,
    phase TEXT,
    error_msg TEXT,
    output_path TEXT,
    pic TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    quality INTEGER,
    video_title TEXT,
    size INTEGER,
    duration INTEGER,
    owner_name TEXT,
    subtitle_only INTEGER NOT NULL DEFAULT 0,
    audio_only INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS download_stats (
    id INTEGER PRIMARY KEY,
    done_count INTEGER NOT NULL DEFAULT 0,
    done_size INTEGER NOT NULL DEFAULT 0,
    done_duration INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS play_progress (
    cid INTEGER PRIMARY KEY,
    bvid TEXT NOT NULL,
    position REAL NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_history (
    keyword TEXT PRIMARY KEY,
    searched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    cover TEXT NOT NULL DEFAULT '',
    upper_name TEXT NOT NULL DEFAULT '',
    upper_mid INTEGER NOT NULL DEFAULT 0,
    known_bvids TEXT NOT NULL DEFAULT '[]',
    last_check TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_download_created ON download_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parse_parsed ON parse_history(parsed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_kind_source ON subscriptions(kind, source_id);
";

#[cfg(test)]
mod tests {
    use super::*;

    /// 辅助：内存库按 1.0 正式流程初始化（建表 + 重建路径 + 记版本）
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        rebuild_db(&conn).unwrap();
        conn
    }

    #[test]
    fn fresh_db_gets_current_schema_version() {
        // 全新库：建表后 schema_version 空表（=0），重建路径记录到当前版本
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        assert_eq!(current_schema_version(&conn), 0);
        rebuild_db(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), SCHEMA_VERSION);
    }

    #[test]
    fn legacy_db_is_rebuilt_and_old_data_discarded() {
        // 模拟 0.x 旧库（schema_version=8，含旧数据）：1.0 断代重建后旧数据丢弃、版本更新
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute("INSERT OR REPLACE INTO schema_version (version) VALUES (8)", []).unwrap();
        conn.execute(
            "INSERT INTO download_history (id, title, bvid, cid, status, progress, created_at)
             VALUES ('old-1', '老视频', 'BV0yy', 1, 'done', 100.0, '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        assert_eq!(current_schema_version(&conn), 8);

        // 版本不匹配 → 重建
        rebuild_db(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), SCHEMA_VERSION);
        let rows = get_downloads_filtered(&conn, None, 10, 0).unwrap();
        assert!(rows.is_empty(), "断代重建后旧数据必须被丢弃");
    }

    #[test]
    fn rebuild_is_idempotent() {
        let conn = fresh_db();
        // 重复重建不报错，版本保持当前值
        rebuild_db(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), SCHEMA_VERSION);
    }

    #[test]
    fn insert_and_read_download_roundtrip() {
        // 端到端：全新库能正常插入/读取全字段下载记录
        let conn = fresh_db();

        let entry = sample_entry();
        insert_download(&conn, &entry).unwrap();

        let rows = get_downloads_filtered(&conn, None, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pic.as_deref(), Some("https://example.com/cover.jpg"));
        assert_eq!(rows[0].title, "测试视频");
        assert_eq!(rows[0].quality, Some(80));
        assert_eq!(rows[0].video_title.as_deref(), Some("合集名"));
        assert_eq!(rows[0].owner_name.as_deref(), Some("某UP"), "owner_name 必须能往返落库（文件名模板 {{up}} 依赖它）");
    }

    #[test]
    fn search_history_upsert_and_cap() {
        // 搜索历史：同词 upsert 不重复，读取按时间降序
        let conn = fresh_db();
        upsert_search_keyword(&conn, "原神").unwrap();
        upsert_search_keyword(&conn, "原神").unwrap();
        upsert_search_keyword(&conn, "鬼畜").unwrap();
        let list = get_search_keywords(&conn, 10).unwrap();
        assert_eq!(list.len(), 2, "同词 upsert 不应产生重复记录");
    }

    #[test]
    fn downloads_filtered_by_status() {
        // 下载库状态标签页：按 status 过滤查询与计数，None 返回全部
        let conn = fresh_db();
        let mut done = sample_entry();
        done.status = "done".into();
        insert_download(&conn, &done).unwrap();
        let mut running = sample_entry();
        running.id = "test-2".into(); // 同 id 会被 INSERT OR REPLACE 覆盖
        insert_download(&conn, &running).unwrap();

        let all = get_downloads_filtered(&conn, None, 10, 0).unwrap();
        assert_eq!(all.len(), 2);
        let only_done = get_downloads_filtered(&conn, Some("done"), 10, 0).unwrap();
        assert_eq!(only_done.len(), 1);
        assert_eq!(only_done[0].status, "done");
        assert_eq!(count_downloads_filtered(&conn, Some("done")).unwrap(), 1);
        assert_eq!(count_downloads_filtered(&conn, None).unwrap(), 2);
        assert_eq!(count_downloads_filtered(&conn, Some("paused")).unwrap(), 0);
    }

    #[test]
    fn download_output_path_lookup() {
        let conn = fresh_db();
        assert!(get_download_output_path(&conn, "nope").unwrap().is_none());
        let mut e = sample_entry();
        e.output_path = Some("D:\\v\\a.mp4".into());
        insert_download(&conn, &e).unwrap();
        assert_eq!(
            get_download_output_path(&conn, "test-1").unwrap().as_deref(),
            Some("D:\\v\\a.mp4")
        );
    }

    /// 辅助：构造一个带全部字段的下载记录
    fn sample_entry() -> DownloadHistoryEntry {
        DownloadHistoryEntry {
            id: "test-1".into(),
            title: "测试视频".into(),
            bvid: "BV1xx".into(),
            cid: 123,
            ep_id: None,
            status: "downloading".into(),
            progress: 50.0,
            phase: Some("video".into()),
            error_msg: None,
            output_path: None,
            pic: Some("https://example.com/cover.jpg".into()),
            created_at: "2026-06-14T00:00:00Z".into(),
            quality: Some(80),
            video_title: Some("合集名".into()),
            size: None,
            duration: Some(360),
            owner_name: Some("某UP".into()),
            subtitle_only: false,
            audio_only: false,
        }
    }

    #[test]
    fn migrate_100_to_101_preserves_data_and_adds_columns() {
        // 模拟 1.0.0 库（version=100，无新列，含用户数据）：
        // 迁移后数据保留、两列可读写、版本更新、重复迁移幂等
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute("DROP TABLE download_history", []).unwrap();
        conn.execute_batch("
            CREATE TABLE download_history (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, bvid TEXT NOT NULL, cid INTEGER NOT NULL,
                ep_id INTEGER, status TEXT NOT NULL DEFAULT 'downloading', progress REAL NOT NULL DEFAULT 0.0,
                phase TEXT, error_msg TEXT, output_path TEXT, pic TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')), quality INTEGER, video_title TEXT,
                size INTEGER, duration INTEGER, owner_name TEXT
            );
        ").unwrap();
        conn.execute("INSERT OR REPLACE INTO schema_version (version) VALUES (100)", []).unwrap();
        conn.execute(
            "INSERT INTO download_history (id, title, bvid, cid, status, progress) VALUES ('keep-1', 'lao', 'BV0yy', 1, 'done', 100.0)",
            [],
        ).unwrap();

        migrate_100_to_101(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), SCHEMA_VERSION);
        let rows = get_downloads_filtered(&conn, None, 10, 0).unwrap();
        assert_eq!(rows.len(), 1, "迁移必须保留用户数据");
        assert_eq!(rows[0].id, "keep-1");
        assert!(!rows[0].subtitle_only && !rows[0].audio_only, "旧行默认 false");

        let mut e = rows.into_iter().next().unwrap();
        e.subtitle_only = true;
        insert_download(&conn, &e).unwrap();
        let rows = get_downloads_filtered(&conn, None, 10, 0).unwrap();
        assert!(rows[0].subtitle_only, "subtitle_only 必须能往返落库");

        migrate_100_to_101(&conn).unwrap();
    }
}
