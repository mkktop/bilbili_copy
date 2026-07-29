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

/// 初始化数据库：建表 + WAL + 版本迁移 + 清理残留
pub fn init_db() -> anyhow::Result<DbState> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(SCHEMA_SQL)?;

    // 增量版本迁移：根据已记录的 schema_version 执行尚未完成的升级
    migrate_schema(&conn)?;

    // 应用异常退出后残留的 downloading 任务改为 paused（而非 error），
    // 让用户可在「下载列表」手动恢复（复用 .tmp 续传）。临时文件由指纹机制保护，
    // 不匹配时 download_stream 会自动丢弃重下，不会损坏。
    conn.execute(
        "UPDATE download_history SET status='paused' WHERE status='downloading'",
        [],
    )?;

    log::info!("[db] 数据库初始化完成: {:?}", db_path());
    Ok(DbState(Mutex::new(conn)))
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

/// 增量迁移：依次应用 version < N 的升级步骤。
/// 新建库的建表语句已包含所有列，迁移只对老库补列。
fn migrate_schema(conn: &Connection) -> anyhow::Result<()> {
    let mut version = current_schema_version(conn);

    // v2: download_history 增加 pic（封面）列
    if version < 2 {
        // 仅在列不存在时添加（兼容已经是 v2 建表语句的新库）
        if !column_exists(conn, "download_history", "pic")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN pic TEXT", [])?;
            log::info!("[db] 迁移 v2: 已为 download_history 添加 pic 列");
        }
        set_schema_version(conn, 2)?;
        version = 2;
    }

    // v3: download_history 增加 quality（画质，用于跨会话续传指纹与恢复下载）与
    //     video_title（合集名，用于重建下载目录路径）两列。
    if version < 3 {
        if !column_exists(conn, "download_history", "quality")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN quality INTEGER", [])?;
            log::info!("[db] 迁移 v3: 已为 download_history 添加 quality 列");
        }
        if !column_exists(conn, "download_history", "video_title")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN video_title TEXT", [])?;
            log::info!("[db] 迁移 v3: 已为 download_history 添加 video_title 列");
        }
        set_schema_version(conn, 3)?;
        version = 3;
    }

    // v4: download_history 增加 size（最终文件字节数）与 duration（视频时长秒）两列，
    //     用于下载统计面板（累计下载视频数 / 总大小 / 总时长）。
    if version < 4 {
        if !column_exists(conn, "download_history", "size")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN size INTEGER", [])?;
            log::info!("[db] 迁移 v4: 已为 download_history 添加 size 列");
        }
        if !column_exists(conn, "download_history", "duration")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN duration INTEGER", [])?;
            log::info!("[db] 迁移 v4: 已为 download_history 添加 duration 列");
        }
        set_schema_version(conn, 4)?;
        version = 4;
    }

    // v5: 新建 download_stats 累加器表（单行，id=1）。
    //     统计独立于 download_history，删除/清空下载历史不影响累计值。
    //     迁移时把已有 status='done' 记录回填进累加器，避免历史数据丢失。
    if version < 5 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS download_stats (
                id INTEGER PRIMARY KEY,
                done_count INTEGER NOT NULL DEFAULT 0,
                done_size INTEGER NOT NULL DEFAULT 0,
                done_duration INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )?;
        backfill_download_stats(conn)?;
        log::info!("[db] 迁移 v5: 已创建 download_stats 累加器表并回填");
        set_schema_version(conn, 5)?;
        version = 5;
    }

    // v6: download_history 增加 owner_name（UP 主名）列。
    //     文件名模板的 {up} 占位符依赖它：恢复/重试场景前端只从 DB 回传此字段，
    //     而非完整 video_meta（后者仅 NFO 开启时透传且字段全部必填，无法局部重建）。
    if version < 6 {
        if !column_exists(conn, "download_history", "owner_name")? {
            conn.execute("ALTER TABLE download_history ADD COLUMN owner_name TEXT", [])?;
            log::info!("[db] 迁移 v6: 已为 download_history 添加 owner_name 列");
        }
        set_schema_version(conn, 6)?;
        version = 6;
    }

    // v7: 新建 play_progress 表（在线播放进度记忆）。cid 主键：每个分P独立记进度。
    if version < 7 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS play_progress (
                cid INTEGER PRIMARY KEY,
                bvid TEXT NOT NULL,
                position REAL NOT NULL,
                duration INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            [],
        )?;
        log::info!("[db] 迁移 v7: 已创建 play_progress 表");
        set_schema_version(conn, 7)?;
        version = 7;
    }

    // v8: 新建 search_history 表（发现页搜索历史）。keyword 主键：同词重搜只刷新时间。
    if version < 8 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS search_history (
                keyword TEXT PRIMARY KEY,
                searched_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            [],
        )?;
        log::info!("[db] 迁移 v8: 已创建 search_history 表");
        set_schema_version(conn, 8)?;
        version = 8;
    }

    if version > 8 {
        log::warn!("[db] schema_version={} 高于当前代码已知的最新版本(8)", version);
    }
    Ok(())
}

/// 通过 PRAGMA table_info 检查某列是否存在（迁移幂等用）
fn column_exists(conn: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let exists = stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        Ok(name)
    })?
    .filter_map(|r| r.ok())
    .any(|name| name == column);
    Ok(exists)
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
        "INSERT OR REPLACE INTO download_history (id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic, quality, video_title, size, duration, owner_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![entry.id, entry.title, entry.bvid, entry.cid, entry.ep_id, entry.status, entry.progress, entry.phase, entry.error_msg, entry.output_path, entry.pic, entry.quality, entry.video_title, entry.size, entry.duration, entry.owner_name],
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
        "UPDATE download_history SET status = ?1, progress = COALESCE(?2, progress), phase = COALESCE(?3, phase), error_msg = COALESCE(?4, error_msg), output_path = COALESCE(?5, output_path), size = COALESCE(?6, size) WHERE id = ?7",
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

pub fn get_all_downloads(conn: &Connection, limit: u32, offset: u32) -> anyhow::Result<Vec<DownloadHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic, created_at, quality, video_title, size, duration, owner_name FROM download_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], |row| {
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
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn count_downloads(conn: &Connection) -> anyhow::Result<u32> {
    let count: u32 = conn.query_row("SELECT COUNT(*) FROM download_history", [], |r| r.get(0))?;
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

/// 一次性回填：把 download_history 中已有 status='done' 的记录汇总写入累加器。
/// 仅在 v5 迁移时调用，保证历史已完成下载不丢失统计。
fn backfill_download_stats(conn: &Connection) -> anyhow::Result<()> {
    let (done_count, done_size, done_duration): (u32, u64, u64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(duration), 0) \
             FROM download_history WHERE status = 'done'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((0, 0, 0));
    conn.execute(
        "INSERT INTO download_stats (id, done_count, done_size, done_duration) VALUES (1, ?1, ?2, ?3) \
         ON CONFLICT(id) DO UPDATE SET \
            done_count = excluded.done_count, \
            done_size = excluded.done_size, \
            done_duration = excluded.done_duration",
        params![done_count, done_size, done_duration],
    )?;
    Ok(())
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
    owner_name TEXT
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

CREATE INDEX IF NOT EXISTS idx_download_created ON download_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parse_parsed ON parse_history(parsed_at DESC);
";

#[cfg(test)]
mod tests {
    use super::*;

    /// 辅助：在内存 SQLite 上构造一个「老库」——即 v1 schema（download_history 无 pic 列）。
    fn legacy_v1_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
             INSERT INTO schema_version (version) VALUES (1);
             CREATE TABLE parse_history (
               id TEXT PRIMARY KEY, url TEXT NOT NULL, bvid TEXT NOT NULL,
               title TEXT NOT NULL, video_info TEXT NOT NULL, parsed_at TEXT NOT NULL
             );
             CREATE TABLE download_history (
               id TEXT PRIMARY KEY, title TEXT NOT NULL, bvid TEXT NOT NULL,
               cid INTEGER NOT NULL, ep_id INTEGER, status TEXT NOT NULL DEFAULT 'downloading',
               progress REAL NOT NULL DEFAULT 0.0, phase TEXT, error_msg TEXT,
               output_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn migrate_v1_adds_pic_column() {
        let conn = legacy_v1_db();
        // 迁移前 download_history 没有 pic 列
        assert!(!column_exists(&conn, "download_history", "pic").unwrap());
        // 版本为 1
        assert_eq!(current_schema_version(&conn), 1);

        migrate_schema(&conn).unwrap();

        // 迁移后 pic 列存在，版本一路升到最新（当前为 8）
        assert!(column_exists(&conn, "download_history", "pic").unwrap());
        assert_eq!(current_schema_version(&conn), 8);
    }

    #[test]
    fn migrate_v3_adds_quality_and_video_title() {
        // 构造一个停在 v2（有 pic，无 quality/video_title）的老库，模拟历史用户升级路径
        let conn = legacy_v1_db();
        // 只跑到 v2：手工应用 v2 迁移并记录版本
        if !column_exists(&conn, "download_history", "pic").unwrap() {
            conn.execute("ALTER TABLE download_history ADD COLUMN pic TEXT", []).unwrap();
        }
        conn.execute("INSERT OR REPLACE INTO schema_version (version) VALUES (2)", []).unwrap();
        assert_eq!(current_schema_version(&conn), 2);
        assert!(!column_exists(&conn, "download_history", "quality").unwrap());
        assert!(!column_exists(&conn, "download_history", "video_title").unwrap());

        // 现在从 v2 升级到 v3
        migrate_schema(&conn).unwrap();

        assert!(column_exists(&conn, "download_history", "quality").unwrap());
        assert!(column_exists(&conn, "download_history", "video_title").unwrap());
        assert_eq!(current_schema_version(&conn), 8);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = legacy_v1_db();
        migrate_schema(&conn).unwrap();
        // 再次执行迁移不应报错（version 已是 3，跳过 ALTER）
        migrate_schema(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), 8);
        assert!(column_exists(&conn, "download_history", "pic").unwrap());
    }

    #[test]
    fn fresh_db_has_pic_and_version_zero_then_upgraded() {
        // 全新库：用 SCHEMA_SQL 建表（schema_version 表为空 → current_schema_version 返回 0）
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        assert_eq!(current_schema_version(&conn), 0);
        // 建表语句已含 pic / quality / video_title / owner_name 列
        assert!(column_exists(&conn, "download_history", "pic").unwrap());
        assert!(column_exists(&conn, "download_history", "quality").unwrap());
        assert!(column_exists(&conn, "download_history", "video_title").unwrap());
        assert!(column_exists(&conn, "download_history", "owner_name").unwrap());

        migrate_schema(&conn).unwrap();
        // 全新库经 migrate_schema 走完所有迁移分支（列已存在则跳过 ALTER，但仍记录 version 到最新 7）
        assert_eq!(current_schema_version(&conn), 8);
    }

    #[test]
    fn insert_and_read_download_with_pic() {
        // 端到端：迁移后能正常插入/读取带 pic 的下载记录
        let conn = legacy_v1_db();
        migrate_schema(&conn).unwrap();

        let entry = sample_entry();
        insert_download(&conn, &entry).unwrap();

        let rows = get_all_downloads(&conn, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pic.as_deref(), Some("https://example.com/cover.jpg"));
        assert_eq!(rows[0].title, "测试视频");
        assert_eq!(rows[0].quality, Some(80));
        assert_eq!(rows[0].video_title.as_deref(), Some("合集名"));
        assert_eq!(rows[0].owner_name.as_deref(), Some("某UP"), "owner_name 必须能往返落库（文件名模板 {{up}} 依赖它）");
    }

    #[test]
    fn legacy_download_without_pic_reads_as_none() {
        // 老记录（迁移前插入，pic 为 NULL）读取时为 None
        let conn = legacy_v1_db();
        // 直接插一条没有 pic 的老记录（迁移前的 schema 没有 pic 列）
        conn.execute(
            "INSERT INTO download_history (id, title, bvid, cid, status, progress, created_at)
             VALUES ('old-1', '老视频', 'BV0yy', 1, 'done', 100.0, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        migrate_schema(&conn).unwrap();

        let rows = get_all_downloads(&conn, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pic, None);
        assert_eq!(rows[0].quality, None);
        assert_eq!(rows[0].video_title, None);
        assert_eq!(rows[0].owner_name, None);
    }

    #[test]
    fn migrate_v6_adds_owner_name() {
        // 构造停在 v5（有 pic/quality/video_title/size/duration，无 owner_name）的老库
        let conn = legacy_v1_db();
        for col in ["pic TEXT", "quality INTEGER", "video_title TEXT", "size INTEGER", "duration INTEGER"] {
            conn.execute(&format!("ALTER TABLE download_history ADD COLUMN {col}"), []).unwrap();
        }
        conn.execute("INSERT OR REPLACE INTO schema_version (version) VALUES (5)", []).unwrap();
        assert_eq!(current_schema_version(&conn), 5);
        assert!(!column_exists(&conn, "download_history", "owner_name").unwrap());

        // v5 → v6：补 owner_name 列
        migrate_schema(&conn).unwrap();
        assert!(column_exists(&conn, "download_history", "owner_name").unwrap(), "v6 迁移必须补出 owner_name 列");
        assert_eq!(current_schema_version(&conn), 8);

        // 老记录 owner_name 读出为 NULL（None），不会因补列破坏既有数据
        conn.execute(
            "INSERT INTO download_history (id, title, bvid, cid, status, progress, created_at)
             VALUES ('v5-1', '老视频', 'BV0yy', 1, 'done', 100.0, '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let rows = get_all_downloads(&conn, 10, 0).unwrap();
        assert_eq!(rows[0].owner_name, None, "v5 时代的老记录 owner_name 必须为 None");
    }

    /// 辅助：构造一个带全部 v3 字段的下载记录
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
        }
    }
}
