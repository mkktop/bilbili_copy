//! MCP (Model Context Protocol) 服务：让 AI 客户端（Claude Desktop / ZCode / Cursor 等）
//! 以 stdio 方式驱动下载器——搜索、解析、下载、查进度、订阅追更、点赞投币收藏等。
//!
//! 入口：`Weiyu.exe --mcp`（lib.rs `run_mcp`）。AI 客户端以管道 stdio 拉起无头实例，
//! 协议走 stdout/stdin，因此本模式下：
//! - 日志只写文件（`run_mcp` 用 `init_mcp_logger`），绝不能碰 stdout；
//! - 与桌面 App 并发运行时共享 exe 同目录的 data.db（WAL 多进程）与 credentials.json；
//! - 无窗口、无托盘、不启动订阅调度器（订阅归桌面 App，避免双份自动下载）。

pub mod tools;

/// MCP 工具层全局限速（令牌桶）：所有走B站网络接口的工具共享一个桶。
/// GUI 不经此路径，不受影响。速率取自 settings.mcp_rate_limit_per_sec
/// （0 = 不限制），每次获取现读现用，改设置即时生效、无需重启 MCP 实例。
pub mod rate_limit {
    use once_cell::sync::Lazy;
    use std::sync::Mutex;
    use std::time::Instant;

    struct Bucket {
        tokens: f64,
        last: Instant,
    }

    static BUCKET: Lazy<Mutex<Bucket>> =
        Lazy::new(|| Mutex::new(Bucket { tokens: 1.0, last: Instant::now() }));

    /// 获取一个调用令牌；桶空时异步等待至补充完成。
    /// 桶容量 = 1 秒的配额（允许短突发），不跨进程（GUI 与无头实例各一份）。
    pub async fn acquire_bili() {
        loop {
            let wait = {
                let per_sec = crate::commands::settings::load_settings().mcp_rate_limit_per_sec;
                if per_sec == 0 {
                    return;
                }
                let mut g = match BUCKET.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let now = Instant::now();
                g.tokens = (g.tokens + now.duration_since(g.last).as_secs_f64() * per_sec as f64)
                    .min(per_sec as f64);
                g.last = now;
                if g.tokens >= 1.0 {
                    g.tokens -= 1.0;
                    return;
                }
                (1.0 - g.tokens) / per_sec as f64
            };
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait)).await;
        }
    }
}

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
