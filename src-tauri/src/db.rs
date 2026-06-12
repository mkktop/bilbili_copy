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

/// 初始化数据库：建表 + WAL + 清理残留
pub fn init_db() -> anyhow::Result<DbState> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(SCHEMA_SQL)?;

    // 清理残留的 downloading 状态（应用异常退出）
    conn.execute(
        "UPDATE download_history SET status='error', error_msg='应用异常退出' WHERE status='downloading'",
        [],
    )?;

    log::info!("[db] 数据库初始化完成: {:?}", db_path());
    Ok(DbState(Mutex::new(conn)))
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
    pub created_at: String,
}

// ==================== CRUD ====================

// ---- Parse History ----

pub fn insert_parse(conn: &Connection, entry: &ParseHistoryEntry) -> anyhow::Result<()> {
    // 按 bvid 去重：已存在则更新（刷新时间移到顶部），否则插入新记录
    let updated = conn.execute(
        "UPDATE parse_history SET title = ?1, video_info = ?2, parsed_at = ?3, url = ?4 WHERE bvid = ?5",
        params![entry.title, entry.video_info.to_string(), entry.parsed_at, entry.url, entry.bvid],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO parse_history (id, url, bvid, title, video_info, parsed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.id, entry.url, entry.bvid, entry.title, entry.video_info.to_string(), entry.parsed_at],
        )?;
    }
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

pub fn clear_all_parses(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM parse_history", [])?;
    Ok(())
}

// ---- Download History ----

pub fn insert_download(conn: &Connection, entry: &DownloadHistoryEntry) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO download_history (id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![entry.id, entry.title, entry.bvid, entry.cid, entry.ep_id, entry.status, entry.progress, entry.phase, entry.error_msg, entry.output_path],
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
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE download_history SET status = ?1, progress = COALESCE(?2, progress), phase = COALESCE(?3, phase), error_msg = COALESCE(?4, error_msg), output_path = COALESCE(?5, output_path) WHERE id = ?6",
        params![status, progress, phase, error_msg, output_path, id],
    )?;
    Ok(())
}

pub fn get_all_downloads(conn: &Connection, limit: u32, offset: u32) -> anyhow::Result<Vec<DownloadHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, created_at FROM download_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
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
            created_at: row.get(10)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn count_downloads(conn: &Connection) -> anyhow::Result<u32> {
    let count: u32 = conn.query_row("SELECT COUNT(*) FROM download_history", [], |r| r.get(0))?;
    Ok(count)
}

pub fn delete_download(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM download_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_all_downloads(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM download_history", [])?;
    Ok(())
}

// ==================== Schema SQL ====================

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_download_created ON download_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parse_parsed ON parse_history(parsed_at DESC);
";
