use crate::bilibili::client::BilibiliClient;
use anyhow::Result;

/// 登录态/Cookie 管理。
/// 骨架阶段：定义接口，不实现具体逻辑。
#[allow(dead_code)]
pub struct Credential {
    sessdata: Option<String>,
    bili_jct: Option<String>,
}

impl Credential {
    pub fn new() -> Self {
        Self {
            sessdata: None,
            bili_jct: None,
        }
    }

    /// 从 Cookie 文件加载登录态。
    /// 后续实现：从 settings.json 或 cookie 文件读取。
    pub async fn load(&mut self) -> Result<()> {
        anyhow::bail!("凭证加载功能尚未实现")
    }

    /// 应用凭证到 HTTP 客户端。
    pub fn apply_to_client(&self, _client: &mut BilibiliClient) -> Result<()> {
        // 后续实现：将 Cookie 设置到 reqwest Client
        Ok(())
    }
}
