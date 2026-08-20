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
    /// 番剧 media_id（/bangumi/media/md28233723）
    pub media_id: Option<u64>,
}

/// 从 URL 字符串中提取 BV 号、AV 号和分P页码
pub fn parse_bilibili_url(input: &str) -> Result<ParsedUrl> {
    let input = input.trim();

    // 如果输入包含中文描述 + URL（如分享链接），提取 URL 部分
    let url_input = if !input.starts_with("http") && input.contains("http") {
        if let Some(pos) = input.find("http") {
            input[pos..].trim_end_matches(&[')', '）', ']', '】', ' ', '\t', '\n', '\r'][..])
        } else {
            input
        }
    } else {
        input
    };

    // 尝试从 URL 中提取
    if url_input.starts_with("http") {
        return parse_from_url(url_input);
    }

    // 纯 BV 号
    if url_input.starts_with("BV") && url_input.len() >= 12 {
        let bvid = url_input.split('?').next().unwrap_or(url_input).to_string();
        let aid = bvid_to_aid(&bvid);
        return Ok(ParsedUrl {
            bvid: Some(bvid),
            aid: Some(aid),
            page: None,
            short_url: None,
            ep_id: None,
            season_id: None,
            media_id: None,
        });
    }

    // 纯 AV 号 (av12345 或 12345)
    let av_str = url_input.strip_prefix("av").unwrap_or(url_input);
    if let Ok(aid) = av_str.parse::<u64>() {
        return Ok(ParsedUrl {
            bvid: None,
            aid: Some(aid),
            page: None,
            short_url: None,
            ep_id: None,
            season_id: None,
            media_id: None,
        });
    }

    anyhow::bail!("无法识别的视频链接或 ID: {}", input)
}

/// 从番剧 URL 提取 media_id（如 /bangumi/media/md28233723）
fn extract_media_id(url: &str) -> Option<u64> {
    for segment in url.split('/') {
        if let Some(md_str) = segment.strip_prefix("md") {
            let media_id = md_str.split('?').next().unwrap_or(md_str);
            // 前缀命中但解析失败时继续看后续段（旧实现提前 return None，
            // 会漏掉 /md废弃段/.../md28233723 这种合法 URL）
            if let Ok(id) = media_id.parse() {
                return Some(id);
            }
        }
    }
    None
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
            media_id: None,
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
            media_id: None,
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
            media_id: None,
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
            media_id: None,
        });
    }

    // 提取番剧 media_id（/bangumi/media/md28233723）
    if let Some(media_id) = extract_media_id(url) {
        return Ok(ParsedUrl {
            bvid: None,
            aid: None,
            page,
            short_url: None,
            ep_id: None,
            season_id: None,
            media_id: Some(media_id),
        });
    }

    // 短链接（b23.tv）需要异步解析重定向。
    // 用 host 判定而非子串匹配：`https://evil.com/?x=b23.tv` 不应被当作短链
    // 向任意站点发起 HEAD 请求（意外外联面）。
    if is_b23_short_url(url) {
        return Ok(ParsedUrl {
            bvid: None,
            aid: None,
            page: None,
            short_url: Some(url.to_string()),
            ep_id: None,
            season_id: None,
            media_id: None,
        });
    }

    anyhow::bail!("无法从链接中提取视频 ID: {}", url)
}

/// 判定 URL 的 host 是否为 b23.tv 短链域（www.b23.tv 同样合法）
fn is_b23_short_url(url: &str) -> bool {
    url.split('/')
        .nth(2)
        .map(|authority| {
            let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
            host == "b23.tv" || host.ends_with(".b23.tv")
        })
        .unwrap_or(false)
}

/// 解析 b23.tv 短链接，跟随重定向获取真实 URL 后提取视频 ID
pub(crate) async fn resolve_short_url(short_url: &str) -> Result<ParsedUrl> {
    // 共享 api_client()：UA 相同且自带超时（旧版无超时，短链挂起会永久阻塞解析）
    let client = crate::bilibili::api_client();

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
    // 匹配 /video/av12345 路径段。前缀命中但不是纯数字时继续找后续段
    // （如 /avatar.jpg/av12345 旧实现会在 avatar 段提前返回 None）
    for segment in url.split('/') {
        if let Some(av_part) = segment.strip_prefix("av") {
            let aid_str = av_part.split('?').next().unwrap_or(av_part);
            if let Ok(aid) = aid_str.parse() {
                return Some(aid);
            }
        }
    }
    None
}

/// 从番剧 URL 提取 ep_id（如 /bangumi/play/ep827835）
fn extract_ep_id(url: &str) -> Option<u64> {
    for segment in url.split('/') {
        if let Some(ep_str) = segment.strip_prefix("ep") {
            let ep_id = ep_str.split('?').next().unwrap_or(ep_str);
            if let Ok(id) = ep_id.parse() {
                return Some(id);
            }
        }
    }
    None
}

/// 从番剧 URL 提取 season_id（如 /bangumi/play/ss48011）
fn extract_season_id(url: &str) -> Option<u64> {
    for segment in url.split('/') {
        if let Some(ss_str) = segment.strip_prefix("ss") {
            let season_id = ss_str.split('?').next().unwrap_or(ss_str);
            if let Ok(id) = season_id.parse() {
                return Some(id);
            }
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
