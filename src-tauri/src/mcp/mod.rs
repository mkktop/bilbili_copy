//! MCP (Model Context Protocol) 服务：让 AI 客户端（Claude Desktop / ZCode / Cursor 等）
//! 以 stdio 方式驱动下载器——搜索、解析、下载、查进度、订阅追更、点赞投币收藏等。
//!
//! 入口：`bilbli_copy.exe --mcp`（lib.rs `run_mcp`）。AI 客户端以管道 stdio 拉起无头实例，
//! 协议走 stdout/stdin，因此本模式下：
//! - 日志只写文件（`run_mcp` 用 `init_mcp_logger`），绝不能碰 stdout；
//! - 与桌面 App 并发运行时共享 exe 同目录的 data.db（WAL 多进程）与 credentials.json；
//! - 无窗口、无托盘、不启动订阅调度器（订阅归桌面 App，避免双份自动下载）。

pub mod tools;

use rmcp::ServiceExt;
use tauri::AppHandle;

/// 运行 MCP stdio 服务直到客户端断开。由 `run_mcp` 的 setup 钩子 spawn；
/// 返回后调用方应退出进程（stdio 断开 = 会话结束，无头进程没有存在意义）。
pub async fn serve(app: AppHandle) -> Result<(), rmcp::RmcpError> {
    let server = tools::BiliMcpServer::new(app);
    let running = server.serve(rmcp::transport::stdio()).await?;
    log::info!("[mcp] stdio 服务已就绪，等待客户端请求");
    let reason = running.waiting().await?;
    log::info!("[mcp] 会话结束: {:?}", reason);
    Ok(())
}
