//! NFO 元数据刮削：生成 Kodi/Jellyfin/Emby 兼容的 `<movie>` NFO XML。
//!
//! 实现参考 bili-sync-up 的 `write_movie_nfo`，简化为单 P UGC 场景（无 tvshow/season/episode 层级）。
//! XML 通过 `String` 拼接生成，避免引入 quick-xml 依赖；特殊字符转义 + CDATA 处理。

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};

use crate::commands::settings::AppSettings;
use crate::download_manager::VideoMeta;

/// 默认国家（B站内容主体为中国）
const DEFAULT_COUNTRY: &str = "中国";
/// 默认制作方
const DEFAULT_STUDIO: &str = "哔哩哔哩";

/// 单 P 视频 NFO 生成器：把元数据快照 + 用户设置渲染成 `<movie>` XML 字符串。
pub struct MovieNfo<'a> {
    pub meta: &'a VideoMeta,
    pub settings: &'a AppSettings,
}

impl<'a> MovieNfo<'a> {
    /// 生成完整的 NFO XML 字符串（带 XML 声明 + UTF-8 编码）。
    pub fn render(&self) -> String {
        let meta = self.meta;
        let s = self.settings;
        let mut out = String::with_capacity(2048);

        // XML 头：固定声明 + 4 空格缩进（与 bili-sync-up 保持一致）
        out.push_str("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n");
        out.push_str("<movie>\n");

        // 标题块
        let title = empty_fallback(&meta.title, "未命名");
        push_text(&mut out, "title", &escape(title), 4);
        push_text(&mut out, "originaltitle", &escape(title), 4);
        push_text(&mut out, "sorttitle", &escape(title), 4);

        // 简介（CDATA 包裹，避免简介里的特殊字符破坏 XML）
        push_cdata(&mut out, "plot", &meta.desc, 4);
        // outline：空标签（保持与 bili-sync-up 模板一致，部分播放器会用此字段预览）
        out.push_str("    <outline />\n");

        // uniqueid：BV 号作为唯一标识（B站来源标记）
        if !meta.bvid.is_empty() {
            out.push_str("    <uniqueid type=\"bilibili\" default=\"true\">");
            out.push_str(&escape(&meta.bvid));
            out.push_str("</uniqueid>\n");
        }

        // 标签 <genre>（受开关控制；普通视频来自 tag API，番剧来自 styles）
        if s.nfo_include_genre {
            for tag in &meta.tags {
                let trimmed = tag.trim();
                if !trimmed.is_empty() {
                    push_text(&mut out, "genre", &escape(trimmed), 4);
                }
            }
        }

        // 国家（固定中国）
        out.push_str("    <country>");
        out.push_str(DEFAULT_COUNTRY);
        out.push_str("</country>\n");

        // 时间块：发布时间（Unix 秒 → 本地时区格式化）
        if meta.pubdate > 0 {
            if let Some(dt) = timestamp_to_datetime(meta.pubdate) {
                push_text(&mut out, "year", &dt.format("%Y").to_string(), 4);
                push_text(&mut out, "premiered", &dt.format("%Y-%m-%d").to_string(), 4);
                push_text(&mut out, "aired", &dt.format("%Y-%m-%d").to_string(), 4);
                push_text(&mut out, "dateadded", &dt.format("%Y-%m-%d %H:%M:%S").to_string(), 4);
            }
        }

        // 制作方（固定哔哩哔哩）
        out.push_str("    <studio>");
        out.push_str(DEFAULT_STUDIO);
        out.push_str("</studio>\n");

        // UP 主 actor 块（受开关控制）
        if s.nfo_include_actor {
            write_actor(&mut out, meta);
        }

        // 时长（秒 → 分钟，向上取整）
        if meta.duration > 0 {
            let minutes = ((meta.duration as f64) / 60.0).ceil() as u64;
            push_text(&mut out, "runtime", &minutes.to_string(), 4);
        }

        // 播放统计（播放量 / 点赞数，受开关控制）
        if s.nfo_include_stats {
            push_text(&mut out, "tag", &format!("播放量: {}", meta.view_count), 4);
            push_text(&mut out, "tag", &format!("点赞数: {}", meta.like_count), 4);
        }

        // 封面 URL（播放器优先用本地 -thumb.jpg，URL 作为后备）
        if !meta.pic.is_empty() {
            push_text(&mut out, "thumb", &escape(&meta.pic), 4);
        }

        out.push_str("</movie>\n");
        out
    }
}

/// 写入 UP 主 `<actor>` 块。role 固定为 "UP主"（与 bili-sync-up 的 UGC 兜底分支一致）。
fn write_actor(out: &mut String, meta: &VideoMeta) {
    let name = empty_fallback(&meta.owner_name, "未知UP主");
    out.push_str("    <actor>\n");
    out.push_str("        <name>");
    out.push_str(&escape(name));
    out.push_str("</name>\n");
    out.push_str("        <role>UP主</role>\n");
    if !meta.owner_face.is_empty() {
        push_text(out, "thumb", &escape(&meta.owner_face), 8);
    }
    if meta.owner_mid > 0 {
        push_text(out, "profile", &format!("https://space.bilibili.com/{}", meta.owner_mid), 8);
    }
    out.push_str("        <order>1</order>\n");
    out.push_str("    </actor>\n");
}

// ==================== 内部工具函数 ====================

/// 写入一个普通文本元素：`<indent><tag>value</tag>\n`
fn push_text(out: &mut String, tag: &str, value: &str, indent: usize) {
    out.push_str(&" ".repeat(indent));
    out.push('<');
    out.push_str(tag);
    out.push('>');
    out.push_str(value);
    out.push_str("</");
    out.push_str(tag);
    out.push_str(">\n");
}

/// 写入 CDATA 包裹的文本元素：`<indent><tag><![CDATA[value]]></tag>\n`
fn push_cdata(out: &mut String, tag: &str, value: &str, indent: usize) {
    out.push_str(&" ".repeat(indent));
    out.push('<');
    out.push_str(tag);
    out.push_str("><![CDATA[");
    out.push_str(value);
    out.push_str("]]></");
    out.push_str(tag);
    out.push_str(">\n");
}

/// XML 特殊字符转义（用于普通文本节点；CDATA 内容无需转义）。
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// 空字符串回退到默认值
fn empty_fallback<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.trim().is_empty() {
        fallback
    } else {
        s
    }
}

/// Unix 秒 → UTC DateTime（NFO 时间格式不强制时区，UTC 与 B站 API 默认时区一致即可）
fn timestamp_to_datetime(secs: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_opt(secs, 0).single()
}

// 让 NaiveDateTime 的导入不产生未使用告警（保留以便未来扩展本地时区格式化）
const _: fn() = || {
    let _ = NaiveDateTime::default;
};

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_meta() -> VideoMeta {
        VideoMeta {
            bvid: "BV1xxxxxxxxx".into(),
            title: "测试<视频>&\"标题\"".into(),
            desc: "简介含 <特殊&字符>".into(),
            pic: "https://example.com/cover.jpg".into(),
            owner_mid: 12345,
            owner_name: "UP主".into(),
            owner_face: "https://example.com/face.jpg".into(),
            duration: 750,
            pubdate: 1_700_000_000,
            view_count: 100_000,
            like_count: 5_000,
            danmaku_count: 1_200,
            tags: vec!["鬼畜".into(), "MAD".into(), "  ".into()], // 含一个空白项验证过滤
        }
    }

    fn default_settings() -> AppSettings {
        AppSettings::default()
    }

    #[test]
    fn renders_basic_movie_nfo() {
        let meta = sample_meta();
        let settings = default_settings();
        let xml = MovieNfo { meta: &meta, settings: &settings }.render();

        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n"));
        assert!(xml.contains("<movie>"));
        assert!(xml.contains("</movie>"));
        // 标题转义
        assert!(xml.contains("<title>测试&lt;视频&gt;&amp;&quot;标题&quot;</title>"));
        // CDATA 简介不转义
        assert!(xml.contains("<plot><![CDATA[简介含 <特殊&字符>]]></plot>"));
        // uniqueid
        assert!(xml.contains("<uniqueid type=\"bilibili\" default=\"true\">BV1xxxxxxxxx</uniqueid>"));
        // genre（tags 经 trim 过滤空白项）
        assert!(xml.contains("<genre>鬼畜</genre>"));
        assert!(xml.contains("<genre>MAD</genre>"));
        assert!(!xml.contains("<genre>  </genre>")); // 空白标签被过滤
        // 时间块（1700000000 = 2023-11-14 UTC）
        assert!(xml.contains("<year>2023</year>"));
        // runtime（750 秒 → 13 分钟）
        assert!(xml.contains("<runtime>13</runtime>"));
        // 统计
        assert!(xml.contains("<tag>播放量: 100000</tag>"));
        assert!(xml.contains("<tag>点赞数: 5000</tag>"));
        // actor
        assert!(xml.contains("<name>UP主</name>"));
        assert!(xml.contains("<role>UP主</role>"));
        assert!(xml.contains("https://space.bilibili.com/12345"));
        // thumb
        assert!(xml.contains("<thumb>https://example.com/cover.jpg</thumb>"));
    }

    #[test]
    fn respects_actor_and_stats_switches() {
        let mut meta = sample_meta();
        meta.owner_name = String::new(); // 测试空 UP 名回退
        let mut settings = default_settings();
        settings.nfo_include_actor = false;
        settings.nfo_include_stats = false;

        let xml = MovieNfo { meta: &meta, settings: &settings }.render();
        assert!(!xml.contains("<actor>"));
        assert!(!xml.contains("<tag>播放量"));
    }

    #[test]
    fn skips_time_block_when_pubdate_zero() {
        let mut meta = sample_meta();
        meta.pubdate = 0;
        let settings = default_settings();
        let xml = MovieNfo { meta: &meta, settings: &settings }.render();
        assert!(!xml.contains("<year>"));
        assert!(!xml.contains("<aired>"));
    }

    #[test]
    fn respects_genre_switch() {
        let meta = sample_meta();
        let mut settings = default_settings();
        settings.nfo_include_genre = false;
        let xml = MovieNfo { meta: &meta, settings: &settings }.render();
        // genre 开关关闭后，即使 meta.tags 非空也不输出 <genre>
        assert!(!xml.contains("<genre>鬼畜</genre>"));
        assert!(!xml.contains("<genre>MAD</genre>"));
    }
}
