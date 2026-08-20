use crate::bilibili::credential::Credential;
use crate::bilibili::search::{self, HotSearchItem, SearchResultList};
use crate::db;
use tauri::State;

/// 搜索 B站内容
/// search_type: video(视频) / bili_user(UP主) / media_bangumi(番剧) / media_ft(影视)
/// order/duration/tids 仅对 video 类型有意义，其它类型会被 B站接口忽略
///   order:    totalrank(综合) / pubdate(最新) / click(播放量) / dm(弹幕数) / stow(收藏)
///   duration: 0(全部) / 1(<10分) / 2(10-30分) / 3(30-60分) / 4(>60分)
///   tids:     0(全部分区) 或分区 tid（多个用逗号分隔）
#[tauri::command]
pub async fn search_videos(
    keyword: String,
    search_type: Option<String>,
    page: Option<u32>,
    order: Option<String>,
    duration: Option<String>,
    tids: Option<String>,
) -> Result<SearchResultList, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;

    let search_type = search_type.unwrap_or_else(|| "video".to_string());
    let page = page.unwrap_or(1);
    let order = order.unwrap_or_else(|| "totalrank".to_string());
    let duration = duration.unwrap_or_else(|| "0".to_string());
    let tids = tids.unwrap_or_else(|| "0".to_string());

    search::search(&keyword, &search_type, page, &credential, &order, &duration, &tids)
        .await
        .map_err(|e| e.to_string())
}

/// 获取 B站热搜榜（公开接口，未登录也可用；已登录则带 cookie）
#[tauri::command]
pub async fn get_hot_search(limit: Option<u32>) -> Result<Vec<HotSearchItem>, String> {
    let credential = Credential::load().ok().flatten();
    search::get_hot_search(limit.unwrap_or(10), credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取搜索联想词（公开接口；输入时下拉提示，失败返回空数组即可）
#[tauri::command]
pub async fn get_search_suggest(term: String) -> Result<Vec<String>, String> {
    match search::get_suggest(term.trim()).await {
        Ok(items) => Ok(items),
        Err(e) => {
            log::debug!("[search] 联想词获取失败（静默）: {}", e);
            Ok(Vec::new())
        }
    }
}

/// 获取搜索历史（最近 limit 条，默认 10）
#[tauri::command]
pub fn get_search_history(
    db: State<'_, db::DbState>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::get_search_keywords(&conn, limit.unwrap_or(10))
        .map_err(|e| format!("查询搜索历史失败: {}", e))
}

/// 保存搜索关键词（搜索发起时调用；重复词只刷新时间置顶）
#[tauri::command]
pub fn save_search_keyword(
    db: State<'_, db::DbState>,
    keyword: String,
) -> Result<(), String> {
    let kw = keyword.trim();
    if kw.is_empty() {
        return Ok(());
    }
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::upsert_search_keyword(&conn, kw).map_err(|e| format!("保存搜索词失败: {}", e))
}

/// 删除单条搜索词
#[tauri::command]
pub fn delete_search_keyword(
    db: State<'_, db::DbState>,
    keyword: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::delete_search_keyword(&conn, &keyword).map_err(|e| format!("删除搜索词失败: {}", e))
}

/// 清空搜索历史
#[tauri::command]
pub fn clear_search_history(db: State<'_, db::DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    db::clear_search_keywords(&conn).map_err(|e| format!("清空搜索历史失败: {}", e))
}
