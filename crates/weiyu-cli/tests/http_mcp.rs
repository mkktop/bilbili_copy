use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use weiyu_cli::{http, query::QueryService};

const TOKEN: &str = "test-token-with-at-least-32-characters";
fn app() -> Router {
    http::router(
        QueryService::new(None, 0, 4, Duration::from_secs(3)),
        TOKEN.into(),
        vec![],
        vec![],
        CancellationToken::new(),
    )
}
fn request(body: Value) -> Request<Body> {
    Request::post("/mcp")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-03-26")
        .header("authorization", format!("Bearer {TOKEN}"))
        .body(Body::from(body.to_string()))
        .unwrap()
}
async fn rpc(app: Router, body: Value) -> Value {
    let response = app.oneshot(request(body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn initialize_list_and_query_over_real_mcp_handler() {
    let server = app();
    let init=rpc(server.clone(),json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"integration-test","version":"1"}}})).await;
    assert_eq!(init["result"]["serverInfo"]["name"], "weiyu-cli");
    let list = rpc(
        server.clone(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    let tools = list["result"]["tools"].as_array().unwrap();
    assert!(tools.len() >= 30);
    for tool in tools {
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert!(![
            "download_video",
            "coin_video",
            "like_video",
            "delete_download",
            "save_settings"
        ]
        .contains(&tool["name"].as_str().unwrap()));
    }
    let result=rpc(server.clone(),json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"parse_url","arguments":{"url":"BV17x411w7KC"}}})).await;
    assert_eq!(result["result"]["isError"], false);
    assert_eq!(result["result"]["structuredContent"]["aid"], 170001);
    let status=rpc(server,json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_login_status","arguments":{}}})).await;
    assert_eq!(status["result"]["structuredContent"]["configured"], false);
}

#[tokio::test]
async fn auth_is_required_but_health_check_is_public() {
    let mut req = request(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
    req.headers_mut().remove("authorization");
    let response = app().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().contains_key("www-authenticate"));
    let mut req = request(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}));
    req.headers_mut()
        .insert("authorization", "Bearer wrong-token".parse().unwrap());
    assert_eq!(
        app().oneshot(req).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let mut req = request(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}));
    req.headers_mut()
        .insert("authorization", format!("bearer {TOKEN}").parse().unwrap());
    assert_eq!(app().oneshot(req).await.unwrap().status(), StatusCode::OK);
    let response = app()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert!(!String::from_utf8_lossy(&body).contains(TOKEN));
}

#[tokio::test]
async fn host_and_origin_rules_apply_to_authenticated_requests() {
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    let mut req = request(body.clone());
    req.headers_mut()
        .insert("host", "unexpected.example".parse().unwrap());
    assert_eq!(
        app().oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut req = request(body.clone());
    req.headers_mut()
        .insert("origin", "https://unexpected.example".parse().unwrap());
    assert_eq!(
        app().oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let configured = http::router(
        QueryService::new(None, 0, 4, Duration::from_secs(3)),
        TOKEN.into(),
        vec!["mcp.example.com".into()],
        vec!["https://client.example.com:443".into()],
        CancellationToken::new(),
    );
    let mut req = request(body);
    req.headers_mut()
        .insert("host", "mcp.example.com".parse().unwrap());
    req.headers_mut()
        .insert("origin", "https://client.example.com".parse().unwrap());
    assert_eq!(
        configured.oneshot(req).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn tool_failures_are_actionable_and_do_not_become_protocol_failures() {
    let result=rpc(app(),json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_videos","arguments":{"keyword":"旅行"}}})).await;
    assert_eq!(result["result"]["isError"], true);
    assert_eq!(
        result["result"]["structuredContent"]["error"]["code"],
        "AUTH_REQUIRED"
    );
    for url in [
        "http://127.0.0.1/",
        "https://www.bilibili.com/video/BV11111111111111111111111111111",
    ] {
        let result=rpc(app(),json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"parse_url","arguments":{"url":url}}})).await;
        assert_eq!(result["result"]["isError"], true);
        assert_eq!(
            result["result"]["structuredContent"]["error"]["code"],
            "INVALID_PARAMS"
        );
    }
    let unknown=rpc(app(),json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"download_video","arguments":{}}})).await;
    assert!(unknown["error"].is_object());
}

#[tokio::test]
async fn oversized_requests_are_rejected() {
    let req = request(
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"parse_url","arguments":{"url":"x".repeat(1024*1024)}}}),
    );
    assert_eq!(
        app().oneshot(req).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
