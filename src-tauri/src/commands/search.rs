use crate::bilibili::credential::Credential;
use crate::bilibili::search::{self, SearchResultList};

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
