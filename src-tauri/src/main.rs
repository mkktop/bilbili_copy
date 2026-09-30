// 防止 release 模式下弹出控制台窗口（debug 模式保留终端方便调试）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // --mcp：无头 MCP 服务模式（AI 客户端经 stdio 拉起），不进入 GUI
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        bilbli_copy_lib::run_mcp();
        return;
    }
    bilbli_copy_lib::run()
}
