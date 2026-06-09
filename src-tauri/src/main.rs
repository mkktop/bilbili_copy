// 防止 release 模式下弹出控制台窗口（debug 模式保留终端方便调试）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bilibili_video_downloader_lib::run()
}
