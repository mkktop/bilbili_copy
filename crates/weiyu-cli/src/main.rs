use clap::{Parser, Subcommand};
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::{io::Read, net::SocketAddr, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;
use weiyu_cli::{
    error::QueryError,
    http, input,
    mcp::QueryServer,
    query::{self, QueryService},
};

#[derive(Parser)]
#[command(
    name = "weiyu-cli",
    version,
    about = "未雨：B站只读查询 CLI 与远程 MCP 服务"
)]
struct Cli {
    /// 单行浏览器Cookie文件；不支持Windows DPAPI凭据文件
    #[arg(long, global = true, env = "WEIYU_COOKIE_FILE")]
    cookie_file: Option<PathBuf>,
    /// 每秒工具查询数，0表示不限制
    #[arg(long,global=true,env="WEIYU_RATE_LIMIT",default_value_t=2,value_parser=clap::value_parser!(u32).range(0..=100))]
    rate_limit: u32,
    #[arg(long,global=true,env="WEIYU_MAX_CONCURRENCY",default_value_t=4,value_parser=clap::value_parser!(u32).range(1..=64))]
    max_concurrency: u32,
    #[arg(long,global=true,env="WEIYU_TIMEOUT_SECS",default_value_t=45,value_parser=clap::value_parser!(u64).range(1..=600))]
    timeout_secs: u64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 输出全部只读工具的JSON Schema
    Tools,
    /// 调用工具，JSON结果写stdout，失败返回非零退出码
    Call {
        tool: String,
        /// JSON参数；传-从stdin读取，最多1MiB
        #[arg(long, default_value = "{}")]
        args: String,
    },
    /// 搜索视频（call search_videos的快捷方式）
    Search {
        keyword: String,
        #[arg(long, default_value_t = 1)]
        page: u32,
        #[arg(long, default_value = "totalrank")]
        order: String,
    },
    /// 查询视频详情（call parse_video的快捷方式）
    Video { url: String },
    /// 通过stdin/stdout运行MCP，日志只写stderr
    Mcp,
    /// 运行远程Streamable HTTP MCP：/mcp，健康检查：/healthz
    Serve {
        #[arg(long, env = "WEIYU_LISTEN", default_value = "127.0.0.1:8787")]
        listen: SocketAddr,
        /// MCP访问令牌文件；也可用WEIYU_MCP_TOKEN环境变量，至少32字符
        #[arg(long, env = "WEIYU_MCP_TOKEN_FILE")]
        token_file: Option<PathBuf>,
        /// MCP对外域名或IP，不含协议；可重复。未指定时只允许本机Host
        #[arg(long, env = "WEIYU_ALLOWED_HOSTS", value_delimiter = ',')]
        allowed_host: Vec<String>,
        /// 允许的Origin；未指定时拒绝所有带Origin的浏览器请求
        #[arg(long, env = "WEIYU_ALLOWED_ORIGINS", value_delimiter = ',')]
        allowed_origin: Vec<String>,
    },
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let cli = Cli::parse();
    let stdio = matches!(cli.command, Command::Mcp);
    match run(cli).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            if !stdio {
                println!("{}", json!({"error":error}));
            }
            std::process::ExitCode::from(1)
        }
    }
}

async fn run(cli: Cli) -> Result<(), QueryError> {
    if matches!(cli.command, Command::Tools) {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"tools":query::tools()}))?
        );
        return Ok(());
    }
    let credential = input::load_cookie(cli.cookie_file.as_deref())?;
    let service = QueryService::new(
        credential,
        cli.rate_limit,
        cli.max_concurrency as usize,
        Duration::from_secs(cli.timeout_secs),
    );
    let (tool, args) = match cli.command {
        Command::Tools => unreachable!(),
        Command::Call { tool, args } => {
            let content = if args == "-" {
                let mut content = String::new();
                std::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_string(&mut content)
                    .map_err(|_| QueryError::invalid("无法读取stdin JSON"))?;
                content
            } else {
                args
            };
            if content.len() > 1024 * 1024 {
                return Err(QueryError::invalid("JSON参数超过1MiB"));
            }
            (tool, serde_json::from_str(&content)?)
        }
        Command::Search {
            keyword,
            page,
            order,
        } => (
            "search_videos".into(),
            json!({"keyword":keyword,"page":page,"order":order}),
        ),
        Command::Video { url } => ("parse_video".into(), json!({"url":url})),
        Command::Mcp => {
            let running = QueryServer(service)
                .serve(rmcp::transport::stdio())
                .await
                .map_err(|_| QueryError::new("MCP_ERROR", "MCP stdio握手失败"))?;
            running
                .waiting()
                .await
                .map_err(|_| QueryError::new("MCP_ERROR", "MCP stdio会话异常结束"))?;
            return Ok(());
        }
        Command::Serve {
            listen,
            token_file,
            allowed_host,
            allowed_origin,
        } => {
            let token = load_token(token_file.as_deref())?;
            let cancel = CancellationToken::new();
            let app = http::router(service, token, allowed_host, allowed_origin, cancel.clone());
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .map_err(|e| QueryError::new("LISTEN_ERROR", e.to_string()))?;
            eprintln!(
                "未雨 HTTP MCP: http://{}/mcp",
                listener.local_addr().unwrap_or(listen)
            );
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    http::shutdown_signal().await;
                    cancel.cancel();
                })
                .await
                .map_err(|e| QueryError::new("SERVER_ERROR", e.to_string()))?;
            return Ok(());
        }
    };
    let result: Value = service.call(&tool, args).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn load_token(path: Option<&std::path::Path>) -> Result<String, QueryError> {
    let value = if let Some(path) = path {
        let bytes = std::fs::metadata(path)
            .map_err(|_| QueryError::new("CONFIG_ERROR", "无法读取MCP令牌文件"))?
            .len();
        if bytes > 4096 {
            return Err(QueryError::new("CONFIG_ERROR", "MCP令牌文件过大"));
        }
        std::fs::read_to_string(path)
            .map_err(|_| QueryError::new("CONFIG_ERROR", "无法读取MCP令牌文件"))?
    } else {
        std::env::var("WEIYU_MCP_TOKEN").map_err(|_| {
            QueryError::new(
                "CONFIG_ERROR",
                "HTTP MCP需要配置WEIYU_MCP_TOKEN或--token-file",
            )
        })?
    };
    let token = value.trim().to_owned();
    if !(32..=4096).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(QueryError::new(
            "CONFIG_ERROR",
            "MCP令牌需为32至4096个可见ASCII字符",
        ));
    }
    Ok(token)
}
