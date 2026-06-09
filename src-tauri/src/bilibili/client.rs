use anyhow::Result;
use reqwest::Client;

/// Bilibili HTTP 客户端封装。
/// 管理 Cookie、默认 Headers、WBI 签名等。
#[allow(dead_code)]
pub struct BilibiliClient {
    client: Client,
}

impl BilibiliClient {
    /// 创建新的客户端实例。
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .cookie_store(true)
            .build()?;

        Ok(Self { client })
    }

    /// 获取底层 reqwest Client 引用。
    pub fn inner(&self) -> &Client {
        &self.client
    }
}
