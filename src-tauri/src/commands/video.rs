/// 解析视频链接，返回视频标题。
/// 骨架阶段：返回占位错误。
#[tauri::command]
pub fn parse_video(url: String) -> Result<String, String> {
    // 后续实现：调用 bilibili::video 模块解析视频信息
    Err(format!("解析功能尚未实现 (URL: {})", url))
}
