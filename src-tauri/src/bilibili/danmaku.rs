use prost::Message;

use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, USER_AGENT};

// ==================== Protobuf 结构体 ====================

/// 弹幕分段响应
#[derive(Clone, Message)]
struct DmSegMobileReply {
    #[prost(message, repeated, tag = "1")]
    elems: Vec<DanmakuElem>,
}

/// 单条弹幕
#[derive(Clone, Message)]
struct DanmakuElem {
    #[prost(int64, tag = "1")]
    id: i64,
    /// 出现位置（毫秒）
    #[prost(int32, tag = "2")]
    progress: i32,
    /// 弹幕类型 (1=滚动, 4=底部, 5=顶部, 6=逆向)
    #[prost(int32, tag = "3")]
    mode: i32,
    #[prost(int32, tag = "4")]
    fontsize: i32,
    /// RGB 颜色
    #[prost(uint32, tag = "5")]
    color: u32,
    #[prost(string, tag = "6")]
    mid_hash: String,
    /// 弹幕正文
    #[prost(string, tag = "7")]
    content: String,
    /// 发送时间戳
    #[prost(int64, tag = "8")]
    ctime: i64,
    #[prost(int32, tag = "9")]
    weight: i32,
    #[prost(string, tag = "10")]
    action: String,
    #[prost(int32, tag = "11")]
    pool: i32,
    #[prost(string, tag = "12")]
    dmid_str: String,
    #[prost(int32, tag = "13")]
    attr: i32,
}

// ==================== Danmu 中间结构 ====================

/// 弹幕类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DanmuType {
    #[default]
    Float,
    Top,
    Bottom,
    Reverse,
}

impl DanmuType {
    fn from_num(num: i32) -> Option<Self> {
        match num {
            1 => Some(DanmuType::Float),
            4 => Some(DanmuType::Bottom),
            5 => Some(DanmuType::Top),
            6 => Some(DanmuType::Reverse),
            _ => None, // 高级弹幕等不支持
        }
    }
}

/// 处理后的弹幕实例（无位置信息）
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Danmu {
    pub timeline_s: f64,
    pub content: String,
    pub r#type: DanmuType,
    pub fontsize: u32,
    pub rgb: (u8, u8, u8),
    pub sent_at: Option<i64>,
    pub source_id: Option<String>,
}

impl From<DanmakuElem> for Danmu {
    fn from(elem: DanmakuElem) -> Self {
        Self {
            timeline_s: elem.progress as f64 / 1000.0,
            content: elem.content,
            r#type: DanmuType::from_num(elem.mode).unwrap_or_default(),
            fontsize: elem.fontsize as u32,
            rgb: (
                ((elem.color >> 16) & 0xFF) as u8,
                ((elem.color >> 8) & 0xFF) as u8,
                (elem.color & 0xFF) as u8,
            ),
            sent_at: Some(elem.ctime),
            source_id: if elem.dmid_str.is_empty() {
                Some(elem.id.to_string())
            } else {
                Some(elem.dmid_str)
            },
        }
    }
}

// ==================== 弹幕获取 API ====================

/// 获取弹幕列表（原始 protobuf 解析），带重试
///
/// - `cid`: 视频 cid
/// - `aid`: 视频 aid
/// - `duration_secs`: 视频时长（秒），用于计算分段数
async fn fetch_danmaku_elems(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    aid: u64,
    duration_secs: u64,
) -> anyhow::Result<Vec<DanmakuElem>> {
    let segment_count = if duration_secs == 0 { 1 } else { (duration_secs + 359) / 360 };
    log::info!("[danmaku] 开始获取弹幕，共{}个分段", segment_count);

    let mut all_elems: Vec<DanmakuElem> = Vec::new();

    for idx in 1..=segment_count {
        match fetch_segment_with_retry(client, credential, cid, aid, idx, 3).await {
            Ok(mut seg) => {
                log::debug!("[danmaku] 成功获取分段 {}/{}, 弹幕数: {}", idx, segment_count, seg.len());
                all_elems.append(&mut seg);
            }
            Err(e) => {
                log::warn!("[danmaku] 获取弹幕分段 {}/{} 失败: {}", idx, segment_count, e);
                // 继续处理其他分段，不因单个分段失败而整体失败
            }
        }
    }

    // 按出现时间排序
    all_elems.sort_by_key(|e| e.progress);
    log::info!("[danmaku] 弹幕获取完成，共{}条", all_elems.len());
    Ok(all_elems)
}

/// 带重试机制的弹幕分段获取（3次重试，线性退避）
async fn fetch_segment_with_retry(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    aid: u64,
    segment_idx: u64,
    max_retries: usize,
) -> anyhow::Result<Vec<DanmakuElem>> {
    let mut last_error = None;

    for attempt in 1..=max_retries {
        match fetch_segment(client, credential, cid, aid, segment_idx).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                last_error = Some(e);
                if attempt < max_retries {
                    let delay = std::time::Duration::from_millis(1000 * attempt as u64);
                    log::debug!(
                        "[danmaku] 分段{}获取失败，{}ms后重试({}/{}): {}",
                        segment_idx, delay.as_millis(), attempt, max_retries, last_error.as_ref().unwrap()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    Err(last_error.unwrap())
}

/// 获取单个弹幕分段，校验 content-type
async fn fetch_segment(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    aid: u64,
    segment_idx: u64,
) -> anyhow::Result<Vec<DanmakuElem>> {
    let url = format!(
        "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={}&pid={}&segment_index={}",
        cid, aid, segment_idx
    );

    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .send()
        .await?;

    if !resp.status().is_success() {
        anyhow::bail!("弹幕API请求失败，状态码: {}", resp.status());
    }

    // 校验 content-type
    let headers = resp.headers().clone();
    let content_type = headers.get("content-type");
    if !content_type.is_some_and(|v| v == "application/octet-stream") {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("弹幕响应 content-type 异常: {:?}, body: {:?}", content_type, body.chars().take(200).collect::<String>());
    }

    let bytes = resp.bytes().await?;
    let seg = DmSegMobileReply::decode(bytes.as_ref())?;
    Ok(seg.elems)
}

// ==================== 公开 API ====================

/// 获取弹幕并转换为 ASS 格式文件（使用指定渲染配置）
pub async fn fetch_danmaku_ass(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    aid: u64,
    duration_secs: u64,
    title: &str,
    opt: &DanmakuOption,
) -> anyhow::Result<String> {
    let elems = fetch_danmaku_elems(client, credential, cid, aid, duration_secs).await?;
    let danmus: Vec<Danmu> = elems.into_iter().map(Danmu::from).collect();
    Ok(to_ass(&danmus, title, opt))
}

/// 获取弹幕原始列表（Danmu 结构），供在线播放器弹幕覆盖层渲染（区别于 ASS 文件导出）
pub async fn fetch_danmaku_list(
    client: &reqwest::Client,
    credential: &Credential,
    cid: i64,
    aid: u64,
    duration_secs: u64,
) -> anyhow::Result<Vec<Danmu>> {
    let elems = fetch_danmaku_elems(client, credential, cid, aid, duration_secs).await?;
    Ok(elems.into_iter().map(Danmu::from).collect())
}

// ==================== ASS 格式输出 ====================

/// ASS 弹幕配置（默认值和 bili-sync-up 一致）。
/// 公开后允许从 `AppSettings` 注入用户配置（字号 / 滚动速度 / 透明度 / 屏蔽顶底）。
#[derive(Clone)]
pub struct DanmakuOption {
    pub duration: f64,
    pub font: String,
    pub font_size: u32,
    pub width_ratio: f64,
    pub horizontal_gap: f64,
    pub lane_size: u32,
    pub float_percentage: f64,
    /// 显示透明度 0.0-1.0（用户视角，1.0=完全不透明），内部换算成 ASS alpha。
    pub opacity: f64,
    pub bold: bool,
    pub outline: f64,
    /// 屏蔽顶部弹幕（固定显示在屏幕顶部）
    pub block_top: bool,
    /// 屏蔽底部弹幕（固定显示在屏幕底部，如字幕位）
    pub block_bottom: bool,
}

impl Default for DanmakuOption {
    fn default() -> Self {
        Self {
            duration: 15.0,
            font: "黑体".to_string(),
            font_size: 25,
            width_ratio: 1.2,
            horizontal_gap: 20.0,
            lane_size: 32,
            float_percentage: 0.5,
            opacity: 0.3,
            bold: true,
            outline: 0.8,
            block_top: false,
            block_bottom: false,
        }
    }
}

impl DanmakuOption {
    /// opacity(0.0-1.0) → ASS alpha 字节（0=完全不透明，255=完全透明）
    fn alpha_byte(&self) -> u8 {
        ((1.0 - self.opacity.clamp(0.0, 1.0)) * 255.0).round() as u8
    }
}

impl Danmu {
    /// 计算弹幕像素长度（汉字全宽，英文 2/3 宽）
    fn length(&self, config: &DanmakuOption) -> f64 {
        let pts = config.font_size
            * self.content.chars().map(|ch| if ch.is_ascii() { 2 } else { 3 }).sum::<u32>()
            / 3;
        pts as f64 * config.width_ratio
    }
}

/// 可绘制实体
struct Drawable {
    danmu: Danmu,
    duration: f64,
    style_name: &'static str,
    effect: DrawEffect,
}

/// 绘制特效
enum DrawEffect {
    /// 滚动弹幕：从 start 移动到 end
    Move { start: (i32, i32), end: (i32, i32) },
    /// 固定弹幕（顶部/底部）：在 pos 处静止显示 duration 秒
    Fixed { pos: (i32, i32) },
}

/// 碰撞类型
enum Collision {
    Separate,
    NotEnoughTime,
    Collide { time_needed: f64 },
}

/// 弹幕槽位。滚动弹幕用 `last_shoot_time`/`last_length` 做速度碰撞；
/// 顶部/底部固定弹幕用 `occupied_until` 做时间窗碰撞（一条没消失前不放第二条）。
#[derive(Debug, Clone)]
struct Lane {
    last_shoot_time: f64,
    last_length: f64,
    /// 固定弹幕占用截止时间（该 lane 上一条固定弹幕的 end 时刻）。
    /// 滚动弹幕 lane 不用此字段（保持 0.0）。
    occupied_until: f64,
}

impl Lane {
    fn draw(danmu: &Danmu, config: &DanmakuOption) -> Self {
        Lane {
            last_shoot_time: danmu.timeline_s,
            last_length: danmu.length(config),
            occupied_until: 0.0,
        }
    }

    /// 固定弹幕占用：从 timeline_s 开始显示 config.duration 秒
    fn occupy_fixed(danmu: &Danmu, config: &DanmakuOption) -> Self {
        Lane {
            last_shoot_time: danmu.timeline_s,
            last_length: danmu.length(config),
            occupied_until: danmu.timeline_s + config.duration,
        }
    }

    fn available_for(&self, other: &Danmu, config: &DanmakuOption, width: f64) -> Collision {
        // duration 下限保护：0 会让 v1/v2 变 inf、NaN 传播到排序 panic
        let t = config.duration.max(0.1);
        let w = width;
        let gap = config.horizontal_gap;

        let v1 = (w + self.last_length) / t;
        let v2 = (w + other.length(config)) / t;
        let delta_t = other.timeline_s - self.last_shoot_time;
        let delta_x = v1 * delta_t - self.last_length;

        if delta_x < gap {
            let other_len = other.length(config);
            if other_len <= self.last_length {
                Collision::Collide { time_needed: (gap - delta_x) / v1 }
            } else {
                Collision::Collide { time_needed: (t - (w - gap) / v2) - delta_t }
            }
        } else {
            let other_len = other.length(config);
            if other_len <= self.last_length {
                Collision::Separate
            } else {
                let pos = v2 * (t - delta_t);
                if pos < (w - gap) {
                    Collision::NotEnoughTime
                } else {
                    Collision::Collide { time_needed: (pos - (w - gap)) / v2 }
                }
            }
        }
    }
}

/// 弹幕画布，处理布局
struct Canvas {
    width: u64,
    height: u64,
    config: DanmakuOption,
    float_lanes: Vec<Option<Lane>>,
    /// 顶部固定弹幕通道（DanmuType::Top）
    top_lanes: Vec<Option<Lane>>,
    /// 底部固定弹幕通道（DanmuType::Bottom）
    bottom_lanes: Vec<Option<Lane>>,
}

impl Canvas {
    fn new(width: u64, height: u64, config: DanmakuOption) -> Self {
        let float_lanes_cnt =
            (config.float_percentage * height as f64 / config.lane_size as f64) as usize;
        // 顶部/底部各预留屏幕高度的 1/4 放固定弹幕（与多数播放器习惯一致）
        let fixed_lanes_cnt = (height as f64 / config.lane_size as f64 / 4.0) as usize;
        let fixed_lanes_cnt = fixed_lanes_cnt.max(1);
        Canvas {
            width,
            height,
            config,
            float_lanes: vec![None; float_lanes_cnt],
            top_lanes: vec![None; fixed_lanes_cnt],
            bottom_lanes: vec![None; fixed_lanes_cnt],
        }
    }

    fn draw(&mut self, danmu: Danmu) -> Option<Drawable> {
        match danmu.r#type {
            DanmuType::Float | DanmuType::Reverse => self.draw_float(danmu),
            DanmuType::Top => {
                if self.config.block_top {
                    return None;
                }
                self.draw_fixed(danmu, FixedKind::Top)
            }
            DanmuType::Bottom => {
                if self.config.block_bottom {
                    return None;
                }
                self.draw_fixed(danmu, FixedKind::Bottom)
            }
        }
    }

    fn draw_float(&mut self, mut danmu: Danmu) -> Option<Drawable> {
        let mut collisions = Vec::with_capacity(self.float_lanes.len());
        for (idx, lane) in self.float_lanes.iter_mut().enumerate() {
            match lane {
                None => return Some(self.draw_float_in_lane(danmu, idx)),
                Some(l) => match l.available_for(&danmu, &self.config, self.width as f64) {
                    Collision::Separate | Collision::NotEnoughTime => {
                        return Some(self.draw_float_in_lane(danmu, idx))
                    }
                    Collision::Collide { time_needed } => {
                        collisions.push((time_needed, idx));
                    }
                },
            }
        }
        if !collisions.is_empty() {
            // total_cmp 对 NaN 也全序，杜绝 settings 异常值传播 NaN 时的 unwrap panic
collisions.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
            let (time_need, lane_idx) = collisions[0];
            if time_need < 1.0 {
                danmu.timeline_s += time_need + 0.01;
                return Some(self.draw_float_in_lane(danmu, lane_idx));
            }
        }
        None
    }

    fn draw_float_in_lane(&mut self, danmu: Danmu, lane_idx: usize) -> Drawable {
        self.float_lanes[lane_idx] = Some(Lane::draw(&danmu, &self.config));
        let y = lane_idx as i32 * self.config.lane_size as i32;
        let l = danmu.length(&self.config);
        Drawable {
            danmu,
            duration: self.config.duration,
            style_name: "Float",
            effect: DrawEffect::Move {
                start: (self.width as i32, y),
                end: (-(l as i32), y),
            },
        }
    }

    /// 顶部/底部固定弹幕：简化碰撞——找到一条该时刻未被占用的通道即放置；
    /// 全部被占用则丢弃（与官方「弹幕太密就少显示几条」的体验一致）。
    fn draw_fixed(&mut self, danmu: Danmu, kind: FixedKind) -> Option<Drawable> {
        let lanes = match kind {
            FixedKind::Top => &mut self.top_lanes,
            FixedKind::Bottom => &mut self.bottom_lanes,
        };
        let now = danmu.timeline_s;
        for (idx, lane) in lanes.iter_mut().enumerate() {
            let free = match lane {
                None => true,
                Some(l) => now >= l.occupied_until,
            };
            if free {
                return Some(self.draw_fixed_in_lane(danmu, kind, idx));
            }
        }
        None
    }

    fn draw_fixed_in_lane(
        &mut self,
        danmu: Danmu,
        kind: FixedKind,
        lane_idx: usize,
    ) -> Drawable {
        let lanes = match kind {
            FixedKind::Top => &mut self.top_lanes,
            FixedKind::Bottom => &mut self.bottom_lanes,
        };
        lanes[lane_idx] = Some(Lane::occupy_fixed(&danmu, &self.config));
        // 居中放置
        let x = (self.width as f64 / 2.0) as i32;
        let y = match kind {
            FixedKind::Top => lane_idx as i32 * self.config.lane_size as i32,
            FixedKind::Bottom => {
                self.height as i32 - (lane_idx as i32 + 1) * self.config.lane_size as i32
            }
        };
        Drawable {
            danmu,
            duration: self.config.duration,
            style_name: match kind {
                FixedKind::Top => "Top",
                FixedKind::Bottom => "Bottom",
            },
            effect: DrawEffect::Fixed { pos: (x, y) },
        }
    }
}

/// 固定弹幕种类（顶部/底部），用于分发到对应通道
enum FixedKind {
    Top,
    Bottom,
}

/// 将弹幕列表转换为 ASS 格式文本（使用指定渲染配置）
fn to_ass(danmus: &[Danmu], title: &str, opt: &DanmakuOption) -> String {
    let width: u64 = 1280;
    let height: u64 = 720;

    // 画布布局（所有权移交：opt 内字段都实现了 Clone，这里克隆一份给 Canvas）
    let mut canvas = Canvas::new(width, height, opt.clone());
    let mut drawables = Vec::new();
    for danmu in danmus {
        if let Some(drawable) = canvas.draw(danmu.clone()) {
            drawables.push(drawable);
        }
    }

    let alpha = opt.alpha_byte();

    // ASS 头部
    let mut ass = format!(
        "\
[Script Info]
; Script generated by bilbli_copy
Title: {title}
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
Aspect Ratio: {width}:{height}
Collisions: Normal
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.601


[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, \
Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    );

    // 样式定义
    for style_name in &["Float", "Bottom", "Top"] {
        ass.push_str(&format!(
            "Style: {style_name},{font},{font_size},&H{a:02x}FFFFFF,&H00FFFFFF,&H{a:02x}000000,&H00000000,\
{bold}, 0, 0, 0, 100, 100, 0.00, 0.00, 1, \
{outline}, 0, 7, 0, 0, 0, 1\n",
            a = alpha,
            font = opt.font,
            font_size = opt.font_size,
            bold = opt.bold as u8,
            outline = opt.outline,
        ));
    }

    ass.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    // 弹幕事件
    for d in &drawables {
        let start = format_ass_time(d.danmu.timeline_s);
        let end = format_ass_time(d.danmu.timeline_s + d.duration);
        let (r, g, b) = d.danmu.rgb;
        let text = escape_ass_text(&d.danmu.content);
        let name = build_event_name(&d.danmu);

        // 滚动弹幕用 \move，固定弹幕（顶/底）用 \pos
        let positioning = match &d.effect {
            DrawEffect::Move { start, end } => {
                format!("\\move({}, {}, {}, {})", start.0, start.1, end.0, end.1)
            }
            DrawEffect::Fixed { pos } => {
                format!("\\pos({}, {})", pos.0, pos.1)
            }
        };

        ass.push_str(&format!(
            "Dialogue: 2,{start},{end},{style},{name},0,0,0,,{{{pos}\\c&H{b:02x}{g:02x}{r:02x}&}}{text}\n",
            start = start,
            end = end,
            style = d.style_name,
            name = name,
            pos = positioning,
            r = r, g = g, b = b,
            text = text,
        ));
    }

    ass
}

/// ASS 时间格式 `H:MM:SS.CC`
fn format_ass_time(t: f64) -> String {
    let secs = t.floor() as u32;
    let hour = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let left = t - (hour * 3600) as f64 - (minutes * 60) as f64;
    format!("{}:{:02}:{:05.2}", hour, minutes, left)
}

/// 构建事件名（用于增量同步去重）
fn build_event_name(danmu: &Danmu) -> String {
    match (danmu.source_id.as_deref(), danmu.sent_at) {
        (Some(source_id), Some(sent_at)) if !source_id.is_empty() => {
            format!("bsync-dm|{}|{}", source_id, sent_at)
        }
        _ => String::new(),
    }
}

/// ASS 文本转义：换行 -> \N；花括号替换为全角——他人弹幕可携带 {\pos(...)} 等
/// override 标签，不处理会作用于整条渲染（覆盖全屏/错位）。
fn escape_ass_text(text: &str) -> String {
    text.trim()
        .replace('\n', "\\N")
        .replace('{', "｛")
        .replace('}', "｝")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn danmu(t: f64, content: &str, ty: DanmuType) -> Danmu {
        Danmu {
            timeline_s: t,
            content: content.to_string(),
            r#type: ty,
            fontsize: 25,
            rgb: (255, 255, 255),
            sent_at: None,
            source_id: None,
        }
    }

    #[test]
    fn alpha_byte_inverts_opacity() {
        let mut opt = DanmakuOption::default();
        // opacity 0.3 → alpha = round((1-0.3)*255) = 179
        opt.opacity = 0.3;
        assert_eq!(opt.alpha_byte(), 179);
        opt.opacity = 1.0; // 完全不透明 → alpha 0
        assert_eq!(opt.alpha_byte(), 0);
        opt.opacity = 0.0; // 完全透明 → alpha 255
        assert_eq!(opt.alpha_byte(), 255);
    }

    #[test]
    fn float_danmu_emits_move() {
        let opt = DanmakuOption::default();
        let ass = to_ass(&[danmu(1.0, "hello", DanmuType::Float)], "t", &opt);
        assert!(ass.contains("\\move("), "滚动弹幕应输出 \\move");
        assert!(!ass.contains("\\pos("));
        assert!(ass.contains("Style: Float"));
    }

    #[test]
    fn top_danmu_emits_pos_when_not_blocked() {
        let opt = DanmakuOption::default();
        let ass = to_ass(&[danmu(1.0, "top msg", DanmuType::Top)], "t", &opt);
        assert!(ass.contains("\\pos("), "顶部弹幕应输出 \\pos");
        assert!(ass.contains("Style: Top"));
        assert!(!ass.contains("\\move("));
    }

    #[test]
    fn bottom_danmu_emits_pos_when_not_blocked() {
        let opt = DanmakuOption::default();
        let ass = to_ass(&[danmu(1.0, "btm msg", DanmuType::Bottom)], "t", &opt);
        assert!(ass.contains("\\pos("));
        assert!(ass.contains("Style: Bottom"));
    }

    #[test]
    fn block_top_drops_top_danmu() {
        let mut opt = DanmakuOption::default();
        opt.block_top = true;
        let ass = to_ass(&[danmu(1.0, "top msg", DanmuType::Top)], "t", &opt);
        // 样式表总会定义 Style: Top（三类 Style 一并写出），所以应针对 Dialogue 行断言。
        // Dialogue 行格式：Dialogue: 2,<start>,<end>,<Style>,... — Top 被屏蔽时应不存在这样的行。
        let top_dialogues: usize = ass
            .lines()
            .filter(|l| l.starts_with("Dialogue:") && l.contains(",Top,"))
            .count();
        assert_eq!(top_dialogues, 0, "block_top 时不应产生 Top 的 Dialogue 行");
    }

    #[test]
    fn block_bottom_drops_bottom_danmu() {
        let mut opt = DanmakuOption::default();
        opt.block_bottom = true;
        let ass = to_ass(&[danmu(1.0, "btm msg", DanmuType::Bottom)], "t", &opt);
        let bottom_dialogues: usize = ass
            .lines()
            .filter(|l| l.starts_with("Dialogue:") && l.contains(",Bottom,"))
            .count();
        assert_eq!(bottom_dialogues, 0, "block_bottom 时不应产生 Bottom 的 Dialogue 行");
    }

    #[test]
    fn font_size_and_opacity_reflect_in_style() {
        let mut opt = DanmakuOption::default();
        opt.font_size = 36;
        opt.opacity = 0.8;
        let ass = to_ass(&[danmu(0.0, "x", DanmuType::Float)], "t", &opt);
        // fontsize=36 直接出现在 Style 行
        assert!(ass.contains(",36,"));
        // alpha = round((1-0.8)*255) = 51 = 0x33
        assert!(ass.contains("&H33FFFFFF"));
    }
}
