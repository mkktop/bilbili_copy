use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct QueryError {
    pub code: &'static str,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, QueryError>;

impl QueryError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_PARAMS", message)
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for QueryError {}

impl From<anyhow::Error> for QueryError {
    fn from(error: anyhow::Error) -> Self {
        let message = error.to_string();
        if message.contains("RISK_CONTROL:") || message.contains("风控") {
            Self::new("BILIBILI_VERIFICATION_REQUIRED", "B站要求验证；请在可信设备完成验证后更新服务器 Cookie，或稍后重试。服务器不会绕过验证。")
        } else {
            Self::new("UPSTREAM_ERROR", message)
        }
    }
}

impl From<serde_json::Error> for QueryError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid(error.to_string())
    }
}
