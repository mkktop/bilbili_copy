//! 下载文件名模板渲染。
//!
//! 模板是 `download_dir` 下的相对路径，`/`（或 `\`）分隔子目录；
//! 占位符：`{title}` `{video_title}` `{bvid}` `{ep}` `{cid}` `{up}`，未知 `{ident}` 渲染为空串。
//! 每段分别过 `sanitize_filename`（防路径穿越 + Windows 保留名 + 200 字符上限），
//! 占位符值里带入的 `/` 也会在段内被清理成 `_`，不会产生额外层级。

use crate::bilibili::download::sanitize_filename;

/// 默认模板：精确复刻历史目录结构（`视频文件夹/文件标题`）
pub const DEFAULT_TEMPLATE: &str = "{video_title}/{title}";

/// 文件名模板渲染上下文（调用方负责 video_title 为空时回退 title 的历史语义）
pub struct TemplateCtx<'a> {
    /// 文件标题（多P时前端已预拼为 `P{n} 分P名`）
    pub title: &'a str,
    /// 视频文件夹名（合集/剧集名；调用方应保证非空——空时回退 title）
    pub video_title: &'a str,
    pub bvid: &'a str,
    /// 番剧 ep_id；非番剧为 None，`{ep}` 渲染为空串
    pub ep: Option<u64>,
    pub cid: i64,
    /// UP 主名；None 或空白时 `{up}` 回退为 `未知UP主`
    pub up: Option<&'a str>,
}

/// 规范化模板：空 / 纯空白 → 默认模板
pub fn normalize_template(template: &str) -> String {
    let t = template.trim();
    if t.is_empty() {
        DEFAULT_TEMPLATE.to_string()
    } else {
        t.to_string()
    }
}

/// 渲染模板 → 清理后的相对路径（不含扩展名）。
/// 所有段都被清空时回退 `sanitize_filename(title)`（再空则 `download`）。
pub fn render_filename_template(template: &str, ctx: &TemplateCtx) -> String {
    let normalized = normalize_template(template);
    let mut segments: Vec<String> = Vec::new();
    for raw in normalized.split(|c| c == '/' || c == '\\') {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let replaced = replace_placeholders(trimmed, ctx);
        // sanitize 会清掉值里带入的斜杠/非法字符、截断 200 字符、处理保留名
        let sanitized = sanitize_filename(&replaced);
        let sanitized = sanitized.trim().to_string();
        if sanitized.is_empty() {
            continue;
        }
        segments.push(sanitized);
    }
    if segments.is_empty() {
        let fallback = sanitize_filename(ctx.title);
        return if fallback.is_empty() {
            "download".to_string()
        } else {
            fallback
        };
    }
    segments.join("/")
}

/// 总路径过长时裁剪（防 Windows MAX_PATH）：从最后一段（文件名）往前依次裁剪，
/// 每段至少保留 1 字符；裁剪后重跑 sanitize 以重新套用保留名保护。
/// `dir_chars` = 下载目录绝对路径长度，`ext_len` = 扩展名长度（不含点）。
/// 长度按 UTF-16 码元计（Windows MAX_PATH 的计量单位）：emoji 等
/// 增补平面字符 1 char = 2 码元，按 char 计数仍会超预算。
pub fn truncate_to_fit(rel: &str, dir_chars: usize, ext_len: usize, budget: usize) -> String {
    let mut segments: Vec<String> = rel.split('/').map(String::from).collect();
    // 总长 = 目录 + 目录后分隔符 + 各段 + 段间分隔符 + '.' + 扩展名
    let path_len = |segs: &[String]| {
        dir_chars
            + 1
            + ext_len
            + 1
            + segs.iter().map(|s| s.encode_utf16().count()).sum::<usize>()
            + segs.len().saturating_sub(1)
    };
    if path_len(&segments) <= budget {
        return rel.to_string();
    }
    for i in (0..segments.len()).rev() {
        let total = path_len(&segments);
        if total <= budget {
            break;
        }
        let over = total - budget;
        let len = segments[i].encode_utf16().count();
        let keep = len.saturating_sub(over).max(1);
        segments[i] = shrink_segment(&segments[i], keep);
    }
    segments.join("/")
}

/// 按 UTF-16 码元预算截取字符串前缀（不会把字符截一半）
fn cut_to_utf16(seg: &str, budget: usize) -> String {
    let mut used = 0usize;
    let mut out = String::new();
    for ch in seg.chars() {
        let w = ch.len_utf16();
        if used + w > budget {
            break;
        }
        out.push(ch);
        used += w;
    }
    out
}

/// 截断单段至 `keep` 个 UTF-16 码元并重新 sanitize。
/// 重跑 sanitize 是必要的：截断可能把段尾恰好截成 Windows 保留名
/// （"CONxxxx" → "CON"），sanitize 会补 "_video" 后缀；若后缀撑爆预算则缩量重试
/// （保留名均 ≤4 字符，第二轮必收敛），空结果兜底 "_"。
fn shrink_segment(seg: &str, keep: usize) -> String {
    let keep = keep.max(1);
    let cut = cut_to_utf16(seg, keep);
    let sanitized = sanitize_filename(&cut);
    if sanitized.encode_utf16().count() <= keep {
        return if sanitized.is_empty() { "_".to_string() } else { sanitized };
    }
    let keep2 = keep.saturating_sub(sanitized.encode_utf16().count() - keep).max(1);
    let out = sanitize_filename(&cut_to_utf16(seg, keep2));
    if out.is_empty() { "_".to_string() } else { out }
}

// ==================== 占位符替换（手写扫描器，不引入 regex 依赖） ====================

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn lookup(ident: &str, ctx: &TemplateCtx) -> String {
    match ident {
        "title" => ctx.title.to_string(),
        "video_title" => ctx.video_title.to_string(),
        "bvid" => ctx.bvid.to_string(),
        "cid" => ctx.cid.to_string(),
        "ep" => ctx.ep.map(|e| e.to_string()).unwrap_or_default(),
        "up" => match ctx.up.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            Some(name) => name.to_string(),
            None => "未知UP主".to_string(),
        },
        _ => String::new(), // 未知占位符 → 空串
    }
}

/// 替换单段中的 `{ident}` 占位符。孤立 `{` / 非标识符内容（如 `{}`、`{a b}`）保留字面。
fn replace_placeholders(segment: &str, ctx: &TemplateCtx) -> String {
    let mut out = String::with_capacity(segment.len());
    let mut i = 0usize;
    while i < segment.len() {
        if segment.as_bytes()[i] == b'{' {
            if let Some(close_rel) = segment[i + 1..].find('}') {
                let ident = &segment[i + 1..i + 1 + close_rel];
                if is_ident(ident) {
                    out.push_str(&lookup(ident, ctx));
                    i += 1 + close_rel + 1;
                    continue;
                }
            }
            out.push('{');
            i += 1;
        } else {
            let ch = segment[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture<'a>(title: &'a str, video_title: &'a str, up: Option<&'a str>, ep: Option<u64>) -> TemplateCtx<'a> {
        TemplateCtx { title, video_title, bvid: "BV17x411w7KC", ep, cid: 12345, up }
    }

    #[test]
    fn default_template_reproduces_legacy_layout() {
        let ctx = fixture("视频标题", "合集名", Some("某UP"), None);
        assert_eq!(
            render_filename_template("", &ctx),
            "合集名/视频标题",
            "空模板必须复刻历史目录结构：视频文件夹/文件标题"
        );
        assert_eq!(
            render_filename_template("   ", &ctx),
            "合集名/视频标题",
            "纯空白模板等同空模板"
        );
    }

    #[test]
    fn full_placeholder_render() {
        let ctx = fixture("视频标题", "合集名", Some("某UP"), Some(1234));
        assert_eq!(
            render_filename_template("{up}/{title} [{bvid}]", &ctx),
            "某UP/视频标题 [BV17x411w7KC]"
        );
        assert_eq!(render_filename_template("EP{ep} {cid}", &ctx), "EP1234 12345");
    }

    #[test]
    fn empty_ep_renders_empty_string() {
        let ctx = fixture("视频标题", "合集名", None, None);
        assert_eq!(
            render_filename_template("EP{ep} {title}", &ctx),
            "EP 视频标题",
            "非番剧 {{ep}} 渲染为空串，不产生 EPNone 之类"
        );
    }

    #[test]
    fn up_fallback_for_missing_or_blank() {
        for up in [None, Some(""), Some("   ")] {
            let ctx = fixture("t", "v", up, None);
            assert_eq!(render_filename_template("{up}", &ctx), "未知UP主", "up={up:?} 应回退");
        }
        let ctx = fixture("t", "v", Some("  某UP  "), None);
        assert_eq!(render_filename_template("{up}", &ctx), "某UP", "up 两端空白应 trim");
    }

    #[test]
    fn value_with_slash_stays_single_segment() {
        let ctx = fixture("a/b", "v", None, None);
        assert_eq!(
            render_filename_template("{title}", &ctx),
            "a_b",
            "占位符值里的斜杠必须在段内被 sanitize 清掉，不能产生额外层级（防路径穿越）"
        );
    }

    #[test]
    fn backslash_splits_segments() {
        let ctx = fixture("t", "v", Some("up"), None);
        assert_eq!(render_filename_template("{up}\\{title}", &ctx), "up/t");
    }

    #[test]
    fn unknown_placeholder_stripped_lone_brace_kept() {
        let ctx = fixture("标题", "v", None, None);
        assert_eq!(render_filename_template("{title}{foo}", &ctx), "标题", "未知占位符 → 空串");
        assert_eq!(render_filename_template("a{b", &ctx), "a{b", "无右括号的孤立 {{ 保留字面");
        assert_eq!(render_filename_template("{}", &ctx), "{}", "空标识符不是占位符，保留字面");
    }

    #[test]
    fn all_empty_segments_fall_back_to_title() {
        let ctx = fixture("回退标题", "v", None, None);
        assert_eq!(render_filename_template("///", &ctx), "回退标题", "全空段回退 title");
        let empty = fixture("", "v", None, None);
        assert_eq!(render_filename_template("{ep}/", &empty), "download", "连 title 都空时兜底 download");
    }

    #[test]
    fn reserved_name_gets_suffix() {
        let ctx = fixture("CON", "v", None, None);
        assert_eq!(render_filename_template("{title}", &ctx), "CON_video", "Windows 保留名沿用 sanitize 规则");
    }

    #[test]
    fn trailing_slash_and_blank_segments_dropped() {
        let ctx = fixture("t", "合集", None, None);
        assert_eq!(render_filename_template("{video_title}/", &ctx), "合集", "尾部空段丢弃");
        assert_eq!(render_filename_template("//{video_title}//t//", &ctx).replace('t', "t"), "合集/t");
    }

    #[test]
    fn truncate_to_fit_trims_last_segment_only() {
        // 目录 100 字符 + 扩展名 3：overhead = 100+2+3 = 105；budget 240 → rel 预算 135
        let long_last = "x".repeat(200);
        let rel = format!("UP主/{}", long_last);
        let out = truncate_to_fit(&rel, 100, 3, 240);
        let total = 100 + 1 + out.chars().count() + 1 + 3;
        assert!(total <= 240, "裁剪后总长 {total} 仍超预算");
        assert!(out.starts_with("UP主/"), "只允许裁剪最后一段，前缀段必须原样保留: {out}");
        // 不超长时原样返回
        assert_eq!(truncate_to_fit("a/b", 10, 3, 240), "a/b", "未超预算不得改动");
    }

    #[test]
    fn truncate_to_fit_never_yields_reserved_name() {
        // "CONxy" 被截到恰好 "CON" 时必须重新套用保留名保护，而非产出 Windows 拒收的设备名
        let out = truncate_to_fit("d/CONxy", 230, 3, 240);
        let last = out.rsplit('/').next().unwrap();
        let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
        assert!(
            !reserved.contains(&last.to_uppercase().as_str()),
            "截断后的文件名不得是 Windows 保留名，实际: {last}"
        );
    }

    #[test]
    fn truncate_to_fit_trims_earlier_segments_when_last_insufficient() {
        // 目录本身已吃掉大部分预算时：末段裁到 1 字符仍超 → 依次向前裁中间段
        let out = truncate_to_fit("verylongdir/verylongname/file", 100, 3, 60);
        assert_eq!(out, "v/v/f", "末段不足时应继续裁剪前面的段，每段至少 1 字符");
    }
}
