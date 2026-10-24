use crate::bilibili::credential::Credential;
use crate::bilibili::{api_client, http_to_https, USER_AGENT};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

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
/// 专栏没有公开的正文 JSON API，正文嵌在页面 `window.__INITIAL_STATE__` 里：
/// - 传统专栏：readInfo.content 为正文 HTML
/// - 新版 opus 格式：readInfo.opus.content.paragraphs 为结构化段落 → 拍平成 HTML
pub async fn get_article(cvid: u64, credential: Option<&Credential>) -> Result<ArticleData> {
    let client = api_client();
    let url = format!("https://www.bilibili.com/read/cv{cvid}");
    let mut req = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://www.bilibili.com/read/home");
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }
    let html = req.send().await?.error_for_status()?.text().await?;

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
        author_name: read_info["author"]["name"].as_str().unwrap_or("").to_string(),
        author_mid: read_info["author"]["mid"].as_i64().unwrap_or(0),
        publish_time: read_info["publish_time"].as_i64().unwrap_or(0),
        words: read_info["words"].as_i64().unwrap_or(0),
        banner_url: http_to_https(read_info["banner_url"].as_str().unwrap_or("")),
        content_html,
    })
}

/// 获取 opus 图文内容（https://www.bilibili.com/opus/{id}，新版专栏/图文动态的统一形态）。
/// 页面 __INITIAL_STATE__.detail.modules 为模块化结构：
/// - MODULE_TYPE_TITLE → 标题（无题图文动态可能缺失）
/// - MODULE_TYPE_AUTHOR → 作者 name/mid/pub_ts
/// - MODULE_TYPE_CONTENT → module_content.paragraphs（与传统专栏的 opus 段落同构，复用拍平）
pub async fn get_opus(opus_id: &str, credential: Option<&Credential>) -> Result<ArticleData> {
    // 防御：id 必须是纯数字（拼 URL 前校验，避免注入）
    if opus_id.is_empty() || !opus_id.bytes().all(|b| b.is_ascii_digit()) {
        anyhow::bail!("非法的 opus id: {opus_id}");
    }
    let client = api_client();
    let url = format!("https://www.bilibili.com/opus/{opus_id}");
    let mut req = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://t.bilibili.com/");
    if let Some(cred) = credential {
        req = req.header("Cookie", cred.cookie_header());
    }
    let html = req.send().await?.error_for_status()?.text().await?;

    let state = extract_initial_state(&html)
        .context("页面中未找到 __INITIAL_STATE__（图文可能已删除或不可见）")?;
    let detail = &state["detail"];
    let modules = detail["modules"]
        .as_array()
        .context("opus 数据缺少 modules（可能为不支持的页面格式）")?;

    let find = |ty: &str| modules.iter().find(|m| m["module_type"].as_str() == Some(ty));

    let author = find("MODULE_TYPE_AUTHOR").map(|m| &m["module_author"]);
    let content = find("MODULE_TYPE_CONTENT")
        .context("opus 数据缺少正文模块")?;
    let content_html = opus_paragraphs_to_html(&content["module_content"]["paragraphs"]);
    if content_html.trim().is_empty() {
        anyhow::bail!("未取到 opus 正文（不支持的图文格式）");
    }

    // 标题：TITLE 模块优先；无题图文动态回退 basic.title（带「 - 哔哩哔哩」后缀，去掉）；再缺用占位
    let title = find("MODULE_TYPE_TITLE")
        .and_then(|m| m["module_title"]["text"].as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            detail["basic"]["title"]
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
        author_mid: author.and_then(|a| a["mid"].as_i64()).unwrap_or(0),
        publish_time: author.and_then(|a| a["pub_ts"].as_i64()).unwrap_or(0),
        words: 0, // opus 页面不返回字数
        banner_url: String::new(),
        content_html,
    })
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
        assert!(html.contains("https://i0.hdslb.com/a.png"), "图片应转 https: {html}");
    }
}
