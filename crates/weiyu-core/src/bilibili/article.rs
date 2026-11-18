use crate::bilibili::credential::Credential;
use crate::bilibili::{api_client, http_to_https, USER_AGENT};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

/// 专栏正文 JSON 接口（比抓页面 HTML 稳定：页面在服务器出口 IP 上容易命中风控验证码）
const ARTICLE_API: &str = "https://api.bilibili.com/x/article/view";
/// opus 图文（新版专栏/图文动态）详情 JSON 接口
const OPUS_API: &str = "https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail";
const ARTICLE_REFERER: &str = "https://www.bilibili.com/read/home";
const OPUS_REFERER: &str = "https://t.bilibili.com/";

/// 专栏文章数据（content_html 为原始正文 HTML，前端负责净化渲染与 Markdown 转换）
#[derive(Debug, Clone, Serialize)]
pub struct ArticleData {
    /// 传统专栏 cv 号；opus 图文时为 0
    pub cvid: u64,
    /// opus 图文 id（字符串：19 位数超出 JS 安全整数，不能走 number）；传统专栏为空
    #[serde(default)]
    pub opus_id: String,
    pub title: String,
    pub author_name: String,
    pub author_mid: i64,
    /// 发布时间（unix 秒）
    pub publish_time: i64,
    /// 字数（接口返回，可能为 0）
    pub words: i64,
    pub banner_url: String,
    pub content_html: String,
}

/// 获取专栏文章内容。
///
/// 优先走 `x/article/view` JSON 接口；失败时回退到旧版页面解析
/// （正文嵌在 `window.__INITIAL_STATE__`，传统专栏为 readInfo.content HTML，
/// 公众号式图文为 readInfo.opus.content.paragraphs）。
pub async fn get_article(cvid: u64, credential: Option<&Credential>) -> Result<ArticleData> {
    let api_err = match get_article_via_api(cvid, credential).await {
        Ok(data) => return Ok(data),
        Err(err) => err,
    };
    log::debug!("[article] 专栏 {cvid} 接口获取失败，回退页面解析: {api_err:#}");
    match get_article_via_html(cvid, credential).await {
        Ok(data) => Ok(data),
        Err(html_err) => Err(api_err.context(format!("页面解析也失败: {html_err:#}"))),
    }
}

async fn get_article_via_api(cvid: u64, credential: Option<&Credential>) -> Result<ArticleData> {
    let resp = fetch_api_json(
        &format!("{ARTICLE_API}?id={cvid}"),
        ARTICLE_REFERER,
        credential,
    )
    .await?;
    ensure_api_ok(&resp, "专栏")?;
    parse_article_data(cvid, &resp["data"])
}

async fn get_article_via_html(cvid: u64, credential: Option<&Credential>) -> Result<ArticleData> {
    let url = format!("https://www.bilibili.com/read/cv{cvid}");
    let html = fetch_page_html(&url, ARTICLE_REFERER, credential).await?;

    let state = extract_initial_state(&html)
        .context("页面中未找到 __INITIAL_STATE__（专栏可能已删除或不可见）")?;
    let read_info = &state["readInfo"];
    if read_info.is_null() {
        anyhow::bail!("专栏数据缺少 readInfo（可能为不支持的页面格式）");
    }

    // 正文：传统 HTML 优先；空则尝试 opus 段落拍平
    let mut content_html = read_info["content"].as_str().unwrap_or("").to_string();
    if content_html.trim().is_empty() {
        content_html = opus_paragraphs_to_html(&read_info["opus"]["content"]["paragraphs"]);
    }
    if content_html.trim().is_empty() {
        anyhow::bail!("未取到专栏正文（不支持的专栏格式）");
    }

    Ok(ArticleData {
        cvid,
        opus_id: String::new(),
        title: read_info["title"].as_str().unwrap_or("").to_string(),
        author_name: read_info["author"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        author_mid: read_info["author"]["mid"].as_i64().unwrap_or(0),
        publish_time: read_info["publish_time"].as_i64().unwrap_or(0),
        words: read_info["words"].as_i64().unwrap_or(0),
        banner_url: http_to_https(read_info["banner_url"].as_str().unwrap_or("")),
        content_html,
    })
}

/// 解析 `x/article/view` 的 `data`。
///
/// - `content` 是正文：老专栏为 HTML；迁移到 opus 的专栏为纯文本（换行分段）
/// - `opus.content.paragraphs` 为结构化段落，纯文本时优先用它（保留引用/列表/图片）
fn parse_article_data(cvid: u64, data: &Value) -> Result<ArticleData> {
    let content_html = article_content_html(data);
    if content_html.trim().is_empty() {
        anyhow::bail!("未取到专栏正文（可能为不支持的专栏格式）");
    }

    Ok(ArticleData {
        cvid,
        opus_id: String::new(),
        title: data["title"].as_str().unwrap_or("").to_string(),
        author_name: data["author"]["name"].as_str().unwrap_or("").to_string(),
        author_mid: value_i64(&data["author"]["mid"]).unwrap_or(0),
        publish_time: value_i64(&data["publish_time"]).unwrap_or(0),
        words: value_i64(&data["words"]).unwrap_or(0),
        banner_url: http_to_https(data["banner_url"].as_str().unwrap_or("")),
        content_html,
    })
}

fn article_content_html(data: &Value) -> String {
    let raw = data["content"].as_str().unwrap_or("");
    if raw.trim().is_empty() {
        return opus_paragraphs_to_html(&data["opus"]["content"]["paragraphs"]);
    }
    if looks_like_html(raw) {
        return raw.to_string();
    }
    // 纯文本正文：优先用结构化段落（保留图片/引用/列表），没有段落再按行转段落
    let from_opus = opus_paragraphs_to_html(&data["opus"]["content"]["paragraphs"]);
    if from_opus.trim().is_empty() {
        plain_text_to_html(raw)
    } else {
        from_opus
    }
}

/// 获取 opus 图文内容（https://www.bilibili.com/opus/{id}，新版专栏/图文动态的统一形态）。
///
/// 优先走 `opus/detail` JSON 接口，失败回退页面解析。
/// 两种数据源的 item/detail 同构，`modules` 结构一致：
/// - MODULE_TYPE_TITLE → 标题（无题图文动态可能缺失）
/// - MODULE_TYPE_AUTHOR → 作者 name/mid/pub_ts（接口里 pub_ts 可能是字符串）
/// - MODULE_TYPE_CONTENT → module_content.paragraphs（复用拍平逻辑）
pub async fn get_opus(opus_id: &str, credential: Option<&Credential>) -> Result<ArticleData> {
    // 防御：id 必须是纯数字（拼 URL 前校验，避免注入）
    if opus_id.is_empty() || !opus_id.bytes().all(|b| b.is_ascii_digit()) {
        anyhow::bail!("非法的 opus id: {opus_id}");
    }

    let api_err = match get_opus_via_api(opus_id, credential).await {
        Ok(data) => return Ok(data),
        Err(err) => err,
    };
    log::debug!("[article] opus {opus_id} 接口获取失败，回退页面解析: {api_err:#}");
    match get_opus_via_html(opus_id, credential).await {
        Ok(data) => Ok(data),
        Err(html_err) => Err(api_err.context(format!("页面解析也失败: {html_err:#}"))),
    }
}

async fn get_opus_via_api(opus_id: &str, credential: Option<&Credential>) -> Result<ArticleData> {
    let url = format!("{OPUS_API}?timezone_offset=-480&id={opus_id}");
    let resp = fetch_api_json(&url, OPUS_REFERER, credential).await?;
    ensure_api_ok(&resp, "图文")?;
    parse_opus_item(opus_id, &resp["data"]["item"])
}

async fn get_opus_via_html(opus_id: &str, credential: Option<&Credential>) -> Result<ArticleData> {
    let url = format!("https://www.bilibili.com/opus/{opus_id}");
    let html = fetch_page_html(&url, OPUS_REFERER, credential).await?;

    let state = extract_initial_state(&html)
        .context("页面中未找到 __INITIAL_STATE__（图文可能已删除或不可见）")?;
    parse_opus_item(opus_id, &state["detail"])
}

/// 解析 opus `item`（接口）或页面 `detail`（两者同构）。
fn parse_opus_item(opus_id: &str, item: &Value) -> Result<ArticleData> {
    let modules = item["modules"]
        .as_array()
        .context("opus 数据缺少 modules（可能为不支持的页面格式）")?;

    let find = |ty: &str| {
        modules
            .iter()
            .find(|m| m["module_type"].as_str() == Some(ty))
    };

    let author = find("MODULE_TYPE_AUTHOR").map(|m| &m["module_author"]);
    let content = find("MODULE_TYPE_CONTENT").context("opus 数据缺少正文模块")?;
    let content_html = opus_paragraphs_to_html(&content["module_content"]["paragraphs"]);
    if content_html.trim().is_empty() {
        anyhow::bail!("未取到 opus 正文（不支持的图文格式）");
    }

    // 标题：TITLE 模块优先；无题图文动态回退 basic.title（带「 - 哔哩哔哩」后缀，去掉）；再缺用占位
    let title = find("MODULE_TYPE_TITLE")
        .and_then(|m| m["module_title"]["text"].as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            item["basic"]["title"]
                .as_str()
                .map(|s| s.trim_end_matches(" - 哔哩哔哩").to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("B站图文 {opus_id}"));

    Ok(ArticleData {
        cvid: 0,
        opus_id: opus_id.to_string(),
        title,
        author_name: author
            .and_then(|a| a["name"].as_str())
            .unwrap_or("")
            .to_string(),
        author_mid: author.and_then(|a| value_i64(&a["mid"])).unwrap_or(0),
        publish_time: author.and_then(|a| value_i64(&a["pub_ts"])).unwrap_or(0),
        words: 0, // opus 页面不返回字数
        banner_url: String::new(),
        content_html,
    })
}

async fn fetch_api_json(
    url: &str,
    referer: &str,
    credential: Option<&Credential>,
) -> Result<Value> {
    let client = api_client();
    let mut req = client.get(url).header("Referer", referer);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }
    let resp = req.send().await?.error_for_status()?;
    resp.json().await.context("接口响应不是合法 JSON")
}

async fn fetch_page_html(
    url: &str,
    referer: &str,
    credential: Option<&Credential>,
) -> Result<String> {
    let client = api_client();
    let mut req = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", referer);
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }
    Ok(req.send().await?.error_for_status()?.text().await?)
}

fn ensure_api_ok(resp: &Value, what: &str) -> Result<()> {
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "{what}接口返回错误 {code}: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }
    Ok(())
}

/// JSON 数字字段兼容字符串（opus 的 pub_ts 在接口里是字符串）
fn value_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// 从页面 HTML 提取 `window.__INITIAL_STATE__={...}` 的 JSON。
/// 用花括号配对定位 JSON 末尾（尾部通常跟 `;(function(){...`，不能整段直接 parse）。
fn extract_initial_state(html: &str) -> Option<Value> {
    let marker = "window.__INITIAL_STATE__=";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let bytes = rest.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }
    // 花括号深度配对（跳过字符串字面量与转义）
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&rest[..=i]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// 正文是否已经是 HTML（老专栏接口返回带标签的片段）
fn looks_like_html(text: &str) -> bool {
    const TAGS: [&str; 10] = [
        "<p>", "<p ", "</p>", "<br", "<div", "</div>", "<img", "<figure", "<h1", "<h2",
    ];
    TAGS.iter().any(|tag| text.contains(tag))
}

/// 纯文本正文按行转段落（转义后包 `<p>`，空行跳过）
fn plain_text_to_html(text: &str) -> String {
    let mut html = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        html.push_str(&format!("<p>{}</p>", escape_html(line)));
    }
    html
}

/// opus 结构化段落 → 简化 HTML（覆盖常见段落类型，未知类型尽力提取文本）。
/// para_type: 1=正文 2=图片 3=分割线 4=引用 5=列表 6=文字标题（观察值，B站未公开文档）
fn opus_paragraphs_to_html(paragraphs: &Value) -> String {
    let Some(list) = paragraphs.as_array() else {
        return String::new();
    };
    let mut html = String::new();
    for p in list {
        let para_type = p["para_type"].as_i64().unwrap_or(1);
        match para_type {
            2 => {
                // 图片段：pic.pics[].url
                if let Some(pics) = p["pic"]["pics"].as_array() {
                    for pic in pics {
                        if let Some(u) = pic["url"].as_str() {
                            html.push_str(&format!(
                                "<figure><img src=\"{}\"/></figure>",
                                http_to_https(u)
                            ));
                        }
                    }
                }
            }
            3 => html.push_str("<hr/>"),
            4 => {
                let text = opus_text_nodes(&p["text"]["nodes"]);
                if !text.is_empty() {
                    html.push_str(&format!("<blockquote><p>{}</p></blockquote>", text));
                }
            }
            5 => {
                // 列表段：list.items[].nodes
                if let Some(items) = p["list"]["items"].as_array() {
                    html.push_str("<ul>");
                    for it in items {
                        html.push_str(&format!("<li>{}</li>", opus_text_nodes(&it["nodes"])));
                    }
                    html.push_str("</ul>");
                }
            }
            6 => {
                let text = opus_text_nodes(&p["text"]["nodes"]);
                if !text.is_empty() {
                    html.push_str(&format!("<h2>{}</h2>", text));
                }
            }
            _ => {
                let text = opus_text_nodes(&p["text"]["nodes"]);
                if !text.is_empty() {
                    html.push_str(&format!("<p>{}</p>", text));
                }
            }
        }
    }
    html
}

/// opus 文本节点拍平为转义后的行内 HTML（加粗保留 <strong>）
fn opus_text_nodes(nodes: &Value) -> String {
    let Some(list) = nodes.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for n in list {
        let words = n["word"]["words"].as_str().unwrap_or("");
        if words.is_empty() {
            continue;
        }
        let escaped = escape_html(words);
        if n["word"]["style"]["bold"].as_bool().unwrap_or(false) {
            out.push_str(&format!("<strong>{}</strong>", escaped));
        } else {
            out.push_str(&escaped);
        }
    }
    out
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_state_with_trailing_function() {
        let html = r#"<script>window.__INITIAL_STATE__={"readInfo":{"title":"测试{}\"标题"}};(function(){var a=1;})()</script>"#;
        let v = extract_initial_state(html).expect("应能提取 JSON");
        assert_eq!(v["readInfo"]["title"].as_str(), Some("测试{}\"标题"));
    }

    #[test]
    fn extract_state_missing_returns_none() {
        assert!(extract_initial_state("<html>no state</html>").is_none());
    }

    #[test]
    fn opus_text_and_pic_flatten() {
        let paragraphs: Value = serde_json::from_str(
            r#"[
                {"para_type":1,"text":{"nodes":[{"word":{"words":"你好<b>"}}]}},
                {"para_type":2,"pic":{"pics":[{"url":"http://i0.hdslb.com/a.png"}]}}
            ]"#,
        )
        .unwrap();
        let html = opus_paragraphs_to_html(&paragraphs);
        assert!(html.contains("<p>你好&lt;b&gt;</p>"), "文本应转义: {html}");
        assert!(
            html.contains("https://i0.hdslb.com/a.png"),
            "图片应转 https: {html}"
        );
    }

    #[test]
    fn article_api_keeps_legacy_html_content() {
        let data: Value = serde_json::from_str(
            r#"{
                "title":"老专栏",
                "author":{"name":"UP","mid":42},
                "publish_time":1700000000,
                "words":123,
                "banner_url":"http://i0.hdslb.com/b.png",
                "content":"<p>第一段</p><p>第二段</p>"
            }"#,
        )
        .unwrap();
        let a = parse_article_data(7, &data).unwrap();
        assert_eq!(a.cvid, 7);
        assert_eq!(a.title, "老专栏");
        assert_eq!(a.author_name, "UP");
        assert_eq!(a.author_mid, 42);
        assert_eq!(a.words, 123);
        assert_eq!(a.banner_url, "https://i0.hdslb.com/b.png");
        assert!(a.content_html.contains("<p>第一段</p>"));
    }

    #[test]
    fn article_api_prefers_opus_paragraphs_for_plain_text() {
        let data: Value = serde_json::from_str(
            r#"{
                "title":"迁移到 opus 的专栏",
                "author":{"name":"UP","mid":42},
                "content":"第一段\n1. 小标题\n第二段",
                "opus":{"content":{"paragraphs":[
                    {"para_type":6,"text":{"nodes":[{"word":{"words":"小标题"}}]}},
                    {"para_type":1,"text":{"nodes":[{"word":{"words":"正文"}}]}}
                ]}}
            }"#,
        )
        .unwrap();
        let html = parse_article_data(8, &data).unwrap().content_html;
        assert!(html.contains("<h2>小标题</h2>"), "应使用结构化段落: {html}");
        assert!(html.contains("<p>正文</p>"), "应使用结构化段落: {html}");
        assert!(!html.contains("第一段"), "不应重复输出纯文本: {html}");
    }

    #[test]
    fn article_api_plain_text_without_opus_is_paragraphized() {
        let data: Value =
            serde_json::from_str(r#"{"title":"纯文本","content":"第一行<tag>\n\n第二行"}"#)
                .unwrap();
        let html = parse_article_data(9, &data).unwrap().content_html;
        assert_eq!(html, "<p>第一行&lt;tag&gt;</p><p>第二行</p>");
    }

    #[test]
    fn opus_api_item_with_string_pub_ts() {
        let item: Value = serde_json::from_str(
            r#"{
                "basic":{"title":"无题图文 - 哔哩哔哩"},
                "modules":[
                    {"module_type":"MODULE_TYPE_AUTHOR","module_author":{"name":"UP","mid":42,"pub_ts":"1700000000"}},
                    {"module_type":"MODULE_TYPE_CONTENT","module_content":{"paragraphs":[
                        {"para_type":1,"text":{"nodes":[{"word":{"words":"正文"}}]}}
                    ]}}
                ]
            }"#,
        )
        .unwrap();
        let a = parse_opus_item("1234567890123456789", &item).unwrap();
        assert_eq!(a.opus_id, "1234567890123456789");
        assert_eq!(a.title, "无题图文");
        assert_eq!(a.author_name, "UP");
        assert_eq!(a.publish_time, 1700000000);
        assert!(a.content_html.contains("<p>正文</p>"));
    }

    #[test]
    fn opus_api_missing_content_module_errors() {
        let item: Value = serde_json::from_str(r#"{"basic":{"title":"x"},"modules":[]}"#).unwrap();
        assert!(parse_opus_item("1", &item).is_err());
    }
}
