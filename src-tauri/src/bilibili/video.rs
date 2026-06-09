use crate::bilibili::client::BilibiliClient;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 视频基本信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct VideoInfo {
    pub bvid: String,
    pub aid: u64,
    pub title: String,
    pub desc: String,
    pub owner_name: String,
    pub duration: u64,
    pub pic: String,
}

/// 根据视频 URL 解析视频信息。
/// 骨架阶段：返回未实现错误。
#[allow(dead_code)]
pub async fn parse_video_info(_client: &BilibiliClient, _url: &str) -> Result<VideoInfo> {
    // 后续实现：
    // 1. 从 URL 提取 BV 号或 AV 号
    // 2. 调用 api.bilibili.com/x/web-interface/view 获取视频详情
    // 3. 解析返回的 JSON 并构建 VideoInfo
    anyhow::bail!("视频解析功能尚未实现")
}
