use crate::error::{QueryError, Result};
use reqwest::{redirect::Policy, Url};
use std::path::Path;
use weiyu_core::bilibili::{credential::Credential, url};

pub fn validate_bvid(value: &str) -> Result<u64> {
    const ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if value.len() != 12
        || !value.starts_with("BV1")
        || !value[3..].chars().all(|c| ALPHABET.contains(c))
    {
        return Err(QueryError::invalid("bvid 必须是完整的 12 位 BV 号"));
    }
    Ok(url::bvid_to_aid(value))
}

pub fn bounded(value: u32, min: u32, max: u32, name: &str) -> Result<u32> {
    if !(min..=max).contains(&value) {
        return Err(QueryError::invalid(format!(
            "{name} 必须在 {min} 到 {max} 之间"
        )));
    }
    Ok(value)
}

pub fn positive(value: i64, name: &str) -> Result<i64> {
    if value <= 0 {
        return Err(QueryError::invalid(format!("{name} 必须大于 0")));
    }
    Ok(value)
}

pub fn text(value: &str, max: usize, name: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(QueryError::invalid(format!(
            "{name} 不能为空，最多 {max} 个字符"
        )));
    }
    Ok(())
}

fn trusted_url(url: &Url, subtitle: bool) -> bool {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.scheme() != "https"
    {
        return false;
    }
    match url.host_str() {
        Some(host) if subtitle => host.ends_with(".hdslb.com"),
        Some(host) => matches!(
            host,
            "www.bilibili.com" | "bilibili.com" | "m.bilibili.com" | "b23.tv"
        ),
        _ => false,
    }
}

pub fn subtitle_url(value: &str) -> Result<Url> {
    let value = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_owned()
    };
    let parsed = Url::parse(&value).map_err(|_| QueryError::invalid("字幕 URL 无效"))?;
    if !trusted_url(&parsed, true) {
        return Err(QueryError::invalid(
            "字幕 URL 必须来自 HTTPS 的 hdslb.com 字幕 CDN",
        ));
    }
    Ok(parsed)
}

pub fn restricted_client(subtitle: bool) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(weiyu_core::bilibili::USER_AGENT)
        .timeout(weiyu_core::bilibili::API_TIMEOUT)
        .redirect(Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 || !trusted_url(attempt.url(), subtitle) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(anyhow::Error::from)
        .map_err(Into::into)
}

pub async fn parse_link(value: &str) -> Result<url::ParsedUrl> {
    text(value, 4096, "url")?;
    let mut value = value.trim().to_owned();
    if value.starts_with("http://") {
        value = value.replacen("http://", "https://", 1);
    }
    if value.starts_with("https://") {
        let parsed = Url::parse(&value).map_err(|_| QueryError::invalid("视频链接无效"))?;
        if !trusted_url(&parsed, false) {
            return Err(QueryError::invalid(
                "仅支持 bilibili.com 或 b23.tv 视频链接",
            ));
        }
        if parsed.host_str() == Some("b23.tv") {
            let response = restricted_client(false)?
                .get(parsed)
                .send()
                .await
                .map_err(anyhow::Error::from)?;
            if !trusted_url(response.url(), false) || response.status().is_redirection() {
                return Err(QueryError::invalid("短链接未跳转到受支持的B站地址"));
            }
            value = response.url().to_string();
        }
        let mut canonical = Url::parse(&value).map_err(|_| QueryError::invalid("视频链接无效"))?;
        canonical.set_fragment(None);
        value = canonical.to_string();
        // Match the shared parser's raw path extraction, including slash-bearing queries.
        for segment in value.split('/') {
            if segment.starts_with("BV") {
                validate_bvid(segment.split('?').next().unwrap_or(segment))?;
            }
        }
    } else if value.starts_with("BV") {
        validate_bvid(&value)?;
    } else if !value
        .strip_prefix("av")
        .unwrap_or(&value)
        .chars()
        .all(|c| c.is_ascii_digit())
    {
        return Err(QueryError::invalid("请提供完整B站链接、BV号或av号"));
    }
    let parsed = url::parse_bilibili_url(&value)?;
    if let Some(bvid) = &parsed.bvid {
        validate_bvid(bvid)?;
    }
    if parsed.aid == Some(0)
        || parsed.ep_id == Some(0)
        || parsed.season_id == Some(0)
        || parsed.media_id == Some(0)
    {
        return Err(QueryError::invalid("视频 ID 必须大于 0"));
    }
    Ok(parsed)
}

/// Explicit operator-provided Cookie only. Desktop DPAPI files cannot be moved to a Linux account.
pub fn load_cookie(path: Option<&Path>) -> Result<Option<Credential>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let metadata = std::fs::metadata(path)
        .map_err(|_| QueryError::new("CONFIG_ERROR", "无法读取 Cookie 文件"))?;
    if metadata.len() > 65536 {
        return Err(QueryError::new("CONFIG_ERROR", "Cookie 文件过大"));
    }
    let content = std::fs::read_to_string(path).map_err(|_| {
        QueryError::new(
            "CONFIG_ERROR",
            "Cookie 文件必须为 UTF-8 文本，不能使用 Windows DPAPI 凭据文件",
        )
    })?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    parse_cookie(&content).map(Some)
}

pub fn parse_cookie(content: &str) -> Result<Credential> {
    let content = content.trim();
    if content.is_empty() || content.contains(['\r', '\n']) {
        return Err(QueryError::new(
            "CONFIG_ERROR",
            "Cookie 文件需包含一行完整的浏览器 Cookie 请求头",
        ));
    }
    let mut values = std::collections::HashMap::new();
    for item in content
        .strip_prefix("Cookie:")
        .unwrap_or(content)
        .split(';')
    {
        if let Some((name, value)) = item.trim().split_once('=') {
            values.insert(name.trim(), value.trim());
        }
    }
    let get = |name| values.get(name).copied().unwrap_or("").to_owned();
    if get("SESSDATA").is_empty() {
        return Err(QueryError::new("CONFIG_ERROR", "Cookie 文件缺少 SESSDATA"));
    }
    Ok(Credential {
        sessdata: get("SESSDATA"),
        bili_jct: get("bili_jct"),
        buvid3: get("buvid3"),
        dedeuserid: get("DedeUserID"),
        ac_time_value: get("ac_time_value"),
        buvid4: values.get("buvid4").map(|v| v.to_string()),
        dedeuserid_ckmd5: values.get("DedeUserID__ckMd5").map(|v| v.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_values_keep_equals_and_are_not_in_errors() {
        let cookie =
            parse_cookie("Cookie: SESSDATA=secret==; bili_jct=csrf; DedeUserID=42").unwrap();
        assert_eq!(cookie.sessdata, "secret==");
        let error = parse_cookie("private_secret_without_session")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("private_secret"));
        assert!(parse_cookie("SESSDATA=x\r\nHost: localhost").is_err());
    }
    #[test]
    fn subtitle_sources_are_restricted() {
        for value in [
            "http://127.0.0.1/a",
            "https://metadata.internal/a",
            "https://a.hdslb.com.evil/a",
            "https://a.hdslb.com:22/a",
            "https://user@a.hdslb.com/a",
        ] {
            assert!(subtitle_url(value).is_err(), "{value}");
        }
        assert!(subtitle_url("//aisubtitle.hdslb.com/bfs/ai_subtitle/a.json").is_ok());
    }
    #[tokio::test]
    async fn links_validate_before_network_or_conversion() {
        for value in [
            "http://127.0.0.1/",
            "https://bilibili.com.evil/video/BV17x411w7KC",
            "https://www.bilibili.com/video/BV11111111111111111111111111111",
            "https://www.bilibili.com/?next=/BV11111111111111111111111111111",
            "https://www.bilibili.com/#/video/BV11111111111111111111111111111",
            "BV111111111111111111111111111",
            "BV1中文xxxxxxxx",
            "av0",
        ] {
            assert!(parse_link(value).await.is_err(), "{value}");
        }
        assert_eq!(parse_link("BV17x411w7KC").await.unwrap().aid, Some(170001));
    }
}
