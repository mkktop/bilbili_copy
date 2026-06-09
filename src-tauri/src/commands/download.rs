/// 下载视频到指定目录。
/// 骨架阶段：返回占位错误。
#[tauri::command]
pub fn download_video(url: String, output_dir: Option<String>) -> Result<String, String> {
    // 后续实现：调用 bilibili::download 模块下载视频
    Err(format!("下载功能尚未实现 (URL: {})", url))
}
