use crate::bilibili::credential::Credential;
use crate::bilibili::weekly::{self, WeeklyDetail, WeeklySeriesItem, WeeklyVideoItem};

/// 获取每周必看全部期数列表（公开接口，无需登录）
#[tauri::command]
pub async fn get_weekly_series() -> Result<Vec<WeeklySeriesItem>, String> {
    let credential = Credential::load().ok().flatten();
    weekly::get_weekly_series_list(credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取每周必看某期详细信息
///
/// @param number 期数（不传则返回最新一期）
#[tauri::command]
pub async fn get_weekly_detail(number: Option<i64>) -> Result<WeeklyDetail, String> {
    let credential = Credential::load().ok().flatten();
    weekly::get_weekly_detail(number, credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// 获取入站必刷榜单（官方编辑精选，公开接口，无需登录）
#[tauri::command]
pub async fn get_precious_list() -> Result<Vec<WeeklyVideoItem>, String> {
    let credential = Credential::load().ok().flatten();
    weekly::get_precious_list(credential.as_ref())
        .await
        .map_err(|e| e.to_string())
}
