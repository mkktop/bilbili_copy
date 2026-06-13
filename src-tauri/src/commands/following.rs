use crate::bilibili::credential::Credential;
use crate::bilibili::following::{self, FollowingItem};
use crate::bilibili::PagedResult;

/// 获取当前登录用户的关注列表（分页，每页 50）
#[tauri::command]
pub async fn get_followings(page: Option<u32>) -> Result<PagedResult<FollowingItem>, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {}", e))?
        .ok_or_else(|| "请先登录".to_string())?;
    let page = page.unwrap_or(1);

    following::get_followings(page, &credential)
        .await
        .map_err(|e| e.to_string())
}
