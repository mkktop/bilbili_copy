use crate::{mcp::QueryServer, query::QueryService};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use serde_json::json;
use std::{error::Error as _, sync::Arc};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

pub fn router(
    service: Arc<QueryService>,
    token: String,
    hosts: Vec<String>,
    origins: Vec<String>,
    cancel: CancellationToken,
) -> Router {
    let mut config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_max_request_body_bytes(1024 * 1024)
        .with_allowed_origins(origins)
        .enforce_origin_validation()
        .with_cancellation_token(cancel);
    if !hosts.is_empty() {
        config = config.with_allowed_hosts(hosts);
    }
    let mcp = StreamableHttpService::new(
        move || Ok(QueryServer(service.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let protected = Router::new()
        .nest_service("/mcp", mcp)
        .layer(middleware::from_fn_with_state(Arc::new(token), authorize));
    Router::new().route("/healthz",get(||async{Json(json!({"status":"ok","service":"weiyu-cli","version":env!("CARGO_PKG_VERSION")}))})).merge(protected)
}

async fn authorize(
    State(token): State<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
        .map(|(_, value)| value);
    if provided.is_some_and(|value| bool::from(value.as_bytes().ct_eq(token.as_bytes()))) {
        if request.method() == axum::http::Method::POST {
            let (parts, body) = request.into_parts();
            let body = match axum::body::to_bytes(body, 1024 * 1024).await {
                Ok(bytes) => Body::from(bytes),
                Err(error) => {
                    let status = if error
                        .source()
                        .is_some_and(|source| source.is::<http_body_util::LengthLimitError>())
                    {
                        StatusCode::PAYLOAD_TOO_LARGE
                    } else {
                        StatusCode::BAD_REQUEST
                    };
                    return (status, Json(json!({"error":"invalid_request_body"}))).into_response();
                }
            };
            return next.run(Request::from_parts(parts, body)).await;
        }
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"weiyu-mcp\"")],
        Json(json!({"error":"unauthorized"})),
    )
        .into_response()
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {_=ctrl_c=>{},_=terminate=>{}}
}
