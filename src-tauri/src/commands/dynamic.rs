use crate::bilibili::credential::Credential;
use crate::bilibili::dynamic::{self, DynamicFeedResult};

/// 获取关注动态视频流（cursor 分页，需登录）
///
/// @param offset 分页游标：首页传 None/空串，下一页传上次响应的 offset
#[tauri::command]
pub async fn get_dynamic_feed(offset: Option<String>) -> Result<DynamicFeedResult, String> {
    let credential = Credential::load()
        .map_err(|e| format!("读取登录信息失败: {e}"))?
        .ok_or("未登录，请先登录后再查看动态")?;

    dynamic::get_dynamic_feed(offset.as_deref().unwrap_or(""), &credential)
        .await
        .map_err(|e| e.to_string())
}
