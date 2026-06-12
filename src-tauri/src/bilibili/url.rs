use anyhow::Result;
use serde::Serialize;

/// 从B站 URL 解析出的视频标识
#[derive(Debug, Clone, Serialize)]
pub struct ParsedUrl {
    pub bvid: Option<String>,
    pub aid: Option<u64>,
    pub page: Option<u32>,
    /// 需要异步解析的短链接（b23.tv）
    pub short_url: Option<String>,
    /// 番剧 ep_id（/bangumi/play/ep12345）
    pub ep_id: Option<u64>,
    /// 番剧 season_id（/bangumi/play/ss12345）
    pub season_id: Option<u64>,
}

/// 从 URL 字符串中提取 BV 号、AV 号和分P页码
pub fn parse_bilibili_url(input: &str) -> Result<ParsedUrl> {
    let input = input.trim();

    // 尝试从 URL 中提取
    if input.starts_with("http") {
        return parse_from_url(input);
    }

    // 纯 BV 号
    if input.starts_with("BV") && input.len() >= 12 {
        let bvid = input.split('?').next().unwrap_or(input).to_string();
        let aid = bvid_to_aid(&bvid);
        return Ok(ParsedUrl {
            bvid: Some(bvid),
            aid: Some(aid),
            page: None,
            short_url: None,
            ep_id: None,
            season_id: None,
        });
    }

    // 纯 AV 号 (av12345 或 12345)
    let av_str = input.strip_prefix("av").unwrap_or(input);
    if let Ok(aid) = av_str.parse::<u64>() {
        return Ok(ParsedUrl {
            bvid: None,
            aid: Some(aid),
            page: None,
            short_url: None,
            ep_id: None,
            season_id: None,
        });
    }

    anyhow::bail!("无法识别的视频链接或 ID: {}", input)
}

fn parse_from_url(url: &str) -> Result<ParsedUrl> {
    // 提取分P页码 (?p=2)
    let page = extract_page_param(url);

    // 提取 BV 号
    if let Some(bvid) = extract_bvid(url) {
        let aid = bvid_to_aid(&bvid);
        return Ok(ParsedUrl {
            bvid: Some(bvid),
            aid: Some(aid),
            page,
            short_url: None,
            ep_id: None,
            season_id: None,
        });
    }

    // 提取 AV 号
    if let Some(aid) = extract_aid(url) {
        return Ok(ParsedUrl {
            bvid: None,
            aid: Some(aid),
            page,
            short_url: None,
            ep_id: None,
            season_id: None,
        });
    }

    // 提取番剧 ep_id（/bangumi/play/ep12345）
    if let Some(ep_id) = extract_ep_id(url) {
        return Ok(ParsedUrl {
            bvid: None,
            aid: None,
            page,
            short_url: None,
            ep_id: Some(ep_id),
            season_id: None,
        });
    }

    // 提取番剧 season_id（/bangumi/play/ss12345）
    if let Some(season_id) = extract_season_id(url) {
        return Ok(ParsedUrl {
            bvid: None,
            aid: None,
            page,
            short_url: None,
            ep_id: None,
            season_id: Some(season_id),
        });
    }

    // 短链接（b23.tv）需要异步解析重定向
    if url.contains("b23.tv") {
        return Ok(ParsedUrl {
            bvid: None,
            aid: None,
            page: None,
            short_url: Some(url.to_string()),
            ep_id: None,
            season_id: None,
        });
    }

    anyhow::bail!("无法从链接中提取视频 ID: {}", url)
}

/// 解析 b23.tv 短链接，跟随重定向获取真实 URL 后提取视频 ID
pub(crate) async fn resolve_short_url(short_url: &str) -> Result<ParsedUrl> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
        .build()?;

    // 用 HEAD 请求跟随重定向，获取最终 URL
    let resp = client.head(short_url).send().await?;

    let final_url = resp.url().to_string();

    // 从最终 URL 中提取视频 ID
    parse_bilibili_url(&final_url)
}

fn extract_page_param(url: &str) -> Option<u32> {
    // 从查询参数 ?p=2 中提取页码
    let query = url.split('?').nth(1)?;
    for param in query.split('&') {
        if let Some(val) = param.strip_prefix("p=") {
            return val.parse().ok();
        }
    }
    None
}

fn extract_bvid(url: &str) -> Option<String> {
    // 匹配 /video/BVxxxxxx 路径段
    for segment in url.split('/') {
        if segment.starts_with("BV") && segment.len() >= 12 {
            // 去掉可能的查询参数
            let bvid = segment.split('?').next().unwrap_or(segment);
            return Some(bvid.to_string());
        }
    }
    None
}

fn extract_aid(url: &str) -> Option<u64> {
    // 匹配 /video/av12345 路径段
    for segment in url.split('/') {
        if let Some(av_part) = segment.strip_prefix("av") {
            let aid_str = av_part.split('?').next().unwrap_or(av_part);
            return aid_str.parse().ok();
        }
    }
    None
}

/// 从番剧 URL 提取 ep_id（如 /bangumi/play/ep827835）
fn extract_ep_id(url: &str) -> Option<u64> {
    for segment in url.split('/') {
        if let Some(ep_str) = segment.strip_prefix("ep") {
            let ep_id = ep_str.split('?').next().unwrap_or(ep_str);
            return ep_id.parse().ok();
        }
    }
    None
}

/// 从番剧 URL 提取 season_id（如 /bangumi/play/ss48011）
fn extract_season_id(url: &str) -> Option<u64> {
    for segment in url.split('/') {
        if let Some(ss_str) = segment.strip_prefix("ss") {
            let season_id = ss_str.split('?').next().unwrap_or(ss_str);
            return season_id.parse().ok();
        }
    }
    None
}

// ==================== BV 转 AV 算法 ====================
// 参考 bili-sync-up 的实现

const XOR_CODE: u64 = 23442827791579;
const MASK_CODE: u64 = 2251799813685247;
const BASE: u64 = 58;
const DATA: &[char] = &[
    'F', 'c', 'w', 'A', 'P', 'N', 'K', 'T', 'M', 'u', 'g', '3', 'G', 'V', '5', 'L', 'j', '7',
    'E', 'J', 'n', 'H', 'p', 'W', 's', 'x', '4', 't', 'b', '8', 'h', 'a', 'Y', 'e', 'v', 'i',
    'q', 'B', 'z', '6', 'r', 'k', 'C', 'y', '1', '2', 'm', 'U', 'S', 'D', 'Q', 'X', '9', 'R',
    'd', 'o', 'Z', 'f',
];

/// BV 号转 AV 号
pub fn bvid_to_aid(bvid: &str) -> u64 {
    let mut chars: Vec<char> = bvid.chars().collect();
    if chars.len() < 12 {
        return 0;
    }
    // 交换位置
    (chars[3], chars[9]) = (chars[9], chars[3]);
    (chars[4], chars[7]) = (chars[7], chars[4]);

    let mut tmp: u64 = 0;
    for ch in chars.into_iter().skip(3) {
        if let Some(idx) = DATA.iter().position(|&x| x == ch) {
            tmp = tmp * BASE + idx as u64;
        }
    }
    (tmp & MASK_CODE) ^ XOR_CODE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_full_url_with_bvid() {
        let result =
            parse_bilibili_url("https://www.bilibili.com/video/BV17x411w7KC").unwrap();
        assert_eq!(result.bvid.as_deref(), Some("BV17x411w7KC"));
        assert!(result.aid.is_some());
        assert!(result.page.is_none());
    }

    #[test]
    fn test_parse_url_with_page() {
        let result =
            parse_bilibili_url("https://www.bilibili.com/video/BV17x411w7KC?p=2").unwrap();
        assert_eq!(result.bvid.as_deref(), Some("BV17x411w7KC"));
        assert_eq!(result.page, Some(2));
    }

    #[test]
    fn test_parse_url_with_av() {
        let result =
            parse_bilibili_url("https://www.bilibili.com/video/av170001").unwrap();
        assert!(result.bvid.is_none());
        assert_eq!(result.aid, Some(170001));
    }

    #[test]
    fn test_parse_bare_bvid() {
        let result = parse_bilibili_url("BV17x411w7KC").unwrap();
        assert_eq!(result.bvid.as_deref(), Some("BV17x411w7KC"));
        assert!(result.aid.is_some());
    }

    #[test]
    fn test_parse_bare_av() {
        let result = parse_bilibili_url("av170001").unwrap();
        assert_eq!(result.aid, Some(170001));
    }

    #[test]
    fn test_parse_invalid() {
        assert!(parse_bilibili_url("https://www.google.com").is_err());
        assert!(parse_bilibili_url("random text").is_err());
    }

    #[test]
    fn test_bvid_to_aid() {
        // BV17x411w7KC 对应的经典测试值
        let aid = bvid_to_aid("BV17x411w7KC");
        assert!(aid > 0);
    }
}
