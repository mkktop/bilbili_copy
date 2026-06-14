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

    // 清理残留的 downloading 状态（应用异常退出）
    conn.execute(
        "UPDATE download_history SET status='error', error_msg='应用异常退出' WHERE status='downloading'",
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

    if version > 2 {
        log::warn!("[db] schema_version={} 高于当前代码已知的最新版本(2)", version);
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
        "INSERT OR REPLACE INTO download_history (id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![entry.id, entry.title, entry.bvid, entry.cid, entry.ep_id, entry.status, entry.progress, entry.phase, entry.error_msg, entry.output_path, entry.pic],
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
        "SELECT id, title, bvid, cid, ep_id, status, progress, phase, error_msg, output_path, pic, created_at FROM download_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

        // 迁移后 pic 列存在，版本升到 2
        assert!(column_exists(&conn, "download_history", "pic").unwrap());
        assert_eq!(current_schema_version(&conn), 2);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = legacy_v1_db();
        migrate_schema(&conn).unwrap();
        // 再次执行迁移不应报错（version 已是 2，跳过 ALTER）
        migrate_schema(&conn).unwrap();
        assert_eq!(current_schema_version(&conn), 2);
        assert!(column_exists(&conn, "download_history", "pic").unwrap());
    }

    #[test]
    fn fresh_db_has_pic_and_version_zero_then_upgraded() {
        // 全新库：用 SCHEMA_SQL 建表（schema_version 表为空 → current_schema_version 返回 0）
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        assert_eq!(current_schema_version(&conn), 0);
        // 建表语句已含 pic 列
        assert!(column_exists(&conn, "download_history", "pic").unwrap());

        migrate_schema(&conn).unwrap();
        // migrate_schema 的 v2 分支：列已存在则跳过 ALTER，但仍记录 version=2
        assert_eq!(current_schema_version(&conn), 2);
    }

    #[test]
    fn insert_and_read_download_with_pic() {
        // 端到端：迁移后能正常插入/读取带 pic 的下载记录
        let conn = legacy_v1_db();
        migrate_schema(&conn).unwrap();

        let entry = DownloadHistoryEntry {
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
        };
        insert_download(&conn, &entry).unwrap();

        let rows = get_all_downloads(&conn, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pic.as_deref(), Some("https://example.com/cover.jpg"));
        assert_eq!(rows[0].title, "测试视频");
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
    }
}
