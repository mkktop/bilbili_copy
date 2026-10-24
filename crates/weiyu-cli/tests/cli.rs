use serde_json::Value;
use std::{process::Command, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process,
};

fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_weiyu-cli"));
    command
        .env_remove("WEIYU_COOKIE_FILE")
        .env_remove("WEIYU_MCP_TOKEN")
        .env_remove("WEIYU_MCP_TOKEN_FILE");
    command
}
#[test]
fn json_cli_supports_query_discovery_and_exit_codes() {
    let result = cli().args(["tools"]).output().unwrap();
    assert!(result.status.success());
    let catalog: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(catalog["tools"].as_array().unwrap().len() >= 30);
    let result = cli()
        .args(["call", "parse_url", "--args", r#"{"url":"BV17x411w7KC"}"#])
        .output()
        .unwrap();
    assert!(result.status.success());
    let parsed: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(parsed["aid"], 170001);
    let result = cli().args(["search", "测试"]).output().unwrap();
    assert!(!result.status.success());
    let parsed: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(parsed["error"]["code"], "AUTH_REQUIRED");
    let result = cli().args(["serve"]).output().unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("HTTP MCP需要配置"));
}

#[test]
fn stdio_configuration_errors_never_pollute_stdout() {
    let result = cli()
        .args(["--cookie-file", "/nonexistent/weiyu-cookie-file", "mcp"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn stdio_mcp_initializes_and_queries_without_log_noise() {
    tokio::time::timeout(Duration::from_secs(10),async{
        let mut child=process::Command::new(env!("CARGO_BIN_EXE_weiyu-cli")).args(["--rate-limit","0","mcp"]).env_remove("WEIYU_COOKIE_FILE").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let mut stdin=child.stdin.take().unwrap();let mut output=BufReader::new(child.stdout.take().unwrap()).lines();
        stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}}\n").await.unwrap();
        let init:Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(init["id"],1);assert_eq!(init["result"]["serverInfo"]["name"],"weiyu-cli");
        stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"parse_url\",\"arguments\":{\"url\":\"BV17x411w7KC\"}}}\n").await.unwrap();
        let result:Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(result["id"],2);assert_eq!(result["result"]["structuredContent"]["aid"],170001);
        stdin.shutdown().await.unwrap();drop(stdin);
        assert!(child.wait().await.unwrap().success());
    }).await.expect("stdio MCP timed out");
}
