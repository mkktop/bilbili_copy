use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::bilibili::fingerprint::{self, Fingerprint};

// ==================== 默认值函数 ====================

fn default_video_max_quality() -> i64 {
    127 // 8K
}

fn default_video_min_quality() -> i64 {
    0 // 不限制
}

fn default_audio_max_quality() -> i64 {
    30251 // Hi-Res 无损
}

fn default_audio_min_quality() -> i64 {
    0 // 不限制
}

fn default_codec_priority() -> Vec<String> {
    vec!["AVC".into(), "HEV".into(), "AV1".into()]
}

fn default_max_concurrent_downloads() -> usize {
    1
}

fn default_max_pages_per_video() -> usize {
    2
}

fn default_parallel_threads() -> usize {
    4
}

/// 仅音频下载的默认输出格式（m4a = 无损封装，mp3 = 转码）
fn default_audio_format() -> String {
    "m4a".to_string()
}

fn default_request_delay_ms() -> u64 {
    0
}

/// 主题模式 "light" | "dark" | "system"
fn default_theme() -> String {
    "light".to_string()
}

// ---- 弹幕渲染（用户可见配置）----

fn default_dm_font_size() -> u32 {
    25 // 中号（前端映射：小18 / 中25 / 大36）
}

fn default_dm_scroll_duration() -> f64 {
    15.0 // 标准滚动时长（秒）；越大越慢
}

fn default_dm_opacity() -> f64 {
    0.3 // 显示透明度 0.0-1.0
}

fn default_subtitle_format() -> String {
    "srt".to_string()
}

// ---- NFO 元数据刮削（用户可见配置）----

fn default_nfo_include_genre() -> bool {
    true // 写入标签 <genre>（视频 tag / 番剧 style）
}

fn default_nfo_include_actor() -> bool {
    true // 写入 UP 主信息 <actor>
}

fn default_nfo_include_stats() -> bool {
    true // 写入播放统计 <tag>(播放量/点赞数)
}

// ==================== 旧格式（用于向后兼容迁移） ====================

#[derive(Debug, Deserialize)]
struct LegacySettings {
    #[serde(default)]
    pub default_download_dir: String,
    #[serde(default)]
    pub auto_update: bool,
    #[serde(default)]
    pub default_max_quality: Option<i64>,
    #[serde(default)]
    pub video_max_quality: Option<i64>,
    #[serde(default)]
    pub video_min_quality: Option<i64>,
    #[serde(default)]
    pub audio_max_quality: Option<i64>,
    #[serde(default)]
    pub audio_min_quality: Option<i64>,
    #[serde(default)]
    pub video_codec_priority: Option<Vec<String>>,
}

// ==================== AppSettings ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub default_download_dir: String,
    #[serde(default)]
    pub auto_update: bool,
    #[serde(default = "default_video_max_quality")]
    pub video_max_quality: i64,
    #[serde(default = "default_video_min_quality")]
    pub video_min_quality: i64,
    #[serde(default = "default_audio_max_quality")]
    pub audio_max_quality: i64,
    #[serde(default = "default_audio_min_quality")]
    pub audio_min_quality: i64,
    #[serde(default = "default_codec_priority")]
    pub video_codec_priority: Vec<String>,
    // 下载并发设置
    #[serde(default = "default_max_concurrent_downloads")]
    pub max_concurrent_downloads: usize,
    #[serde(default = "default_max_pages_per_video")]
    pub max_pages_per_video: usize,
    #[serde(default = "default_parallel_threads")]
    pub parallel_threads: usize,
    // 下载限速（KB/s，0 = 无限制）
    #[serde(default)]
    pub max_download_speed_kbps: u64,
    // 仅音频下载输出格式 "m4a" | "mp3"
    #[serde(default = "default_audio_format")]
    pub audio_format: String,
    // 主题模式 "light" | "dark" | "system"
    #[serde(default = "default_theme")]
    pub theme: String,
    // 防风控 - 设备指纹
    #[serde(default)]
    pub fingerprint_gpu_preset: String,
    #[serde(default)]
    pub fingerprint_resolution_preset: String,
    #[serde(default)]
    pub dm_img_str: String,
    #[serde(default)]
    pub dm_cover_img_str: String,
    #[serde(default)]
    pub dm_img_list: String,
    #[serde(default)]
    pub dm_img_inter: String,
    // 防风控 - 请求间隔
    #[serde(default = "default_request_delay_ms")]
    pub request_delay_ms: u64,
    // 附加下载 - 弹幕
    #[serde(default)]
    pub download_danmaku: bool,
    // 附加下载 - 字幕
    #[serde(default)]
    pub download_subtitle: bool,
    // 弹幕渲染 - 字号 / 滚动时长 / 透明度 / 屏蔽顶底
    #[serde(default = "default_dm_font_size")]
    pub danmaku_font_size: u32,
    #[serde(default = "default_dm_scroll_duration")]
    pub danmaku_scroll_duration: f64,
    #[serde(default = "default_dm_opacity")]
    pub danmaku_opacity: f64,
    #[serde(default)]
    pub danmaku_block_top: bool,
    #[serde(default)]
    pub danmaku_block_bottom: bool,
    // 字幕导出格式 "srt" | "vtt"
    #[serde(default = "default_subtitle_format")]
    pub subtitle_format: String,
    // 附加下载 - NFO 元数据刮削（生成 Kodi/Jellyfin/Emby 兼容的 .nfo + 封面图）
    #[serde(default)]
    pub download_nfo: bool,
    // NFO 详细选项 - 写入标签 <genre>（视频 tag / 番剧 style）
    #[serde(default = "default_nfo_include_genre")]
    pub nfo_include_genre: bool,
    // NFO 详细选项 - 写入 UP 主信息 <actor>
    #[serde(default = "default_nfo_include_actor")]
    pub nfo_include_actor: bool,
    // NFO 详细选项 - 写入播放统计 <tag>(播放量/点赞数)
    #[serde(default = "default_nfo_include_stats")]
    pub nfo_include_stats: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_download_dir: String::new(),
            auto_update: false,
            video_max_quality: default_video_max_quality(),
            video_min_quality: default_video_min_quality(),
            audio_max_quality: default_audio_max_quality(),
            audio_min_quality: default_audio_min_quality(),
            video_codec_priority: default_codec_priority(),
            max_concurrent_downloads: default_max_concurrent_downloads(),
            max_pages_per_video: default_max_pages_per_video(),
            parallel_threads: default_parallel_threads(),
            max_download_speed_kbps: 0,
            audio_format: default_audio_format(),
            theme: default_theme(),
            fingerprint_gpu_preset: String::new(),
            fingerprint_resolution_preset: String::new(),
            dm_img_str: String::new(),
            dm_cover_img_str: String::new(),
            dm_img_list: String::new(),
            dm_img_inter: String::new(),
            request_delay_ms: default_request_delay_ms(),
            download_danmaku: false,
            download_subtitle: false,
            danmaku_font_size: default_dm_font_size(),
            danmaku_scroll_duration: default_dm_scroll_duration(),
            danmaku_opacity: default_dm_opacity(),
            danmaku_block_top: false,
            danmaku_block_bottom: false,
            subtitle_format: default_subtitle_format(),
            download_nfo: false,
            nfo_include_genre: default_nfo_include_genre(),
            nfo_include_actor: default_nfo_include_actor(),
            nfo_include_stats: default_nfo_include_stats(),
        }
    }
}

impl From<LegacySettings> for AppSettings {
    fn from(legacy: LegacySettings) -> Self {
        // 旧 default_max_quality 迁移到 video_max_quality
        let video_max_quality = legacy
            .video_max_quality
            .or(legacy.default_max_quality)
            .unwrap_or(127);

        Self {
            default_download_dir: legacy.default_download_dir,
            auto_update: legacy.auto_update,
            video_max_quality,
            video_min_quality: legacy.video_min_quality.unwrap_or(0),
            audio_max_quality: legacy.audio_max_quality.unwrap_or(30251),
            audio_min_quality: legacy.audio_min_quality.unwrap_or(0),
            video_codec_priority: legacy
                .video_codec_priority
                .unwrap_or_else(default_codec_priority),
            max_concurrent_downloads: default_max_concurrent_downloads(),
            max_pages_per_video: default_max_pages_per_video(),
            parallel_threads: default_parallel_threads(),
            max_download_speed_kbps: 0,
            audio_format: default_audio_format(),
            theme: default_theme(),
            fingerprint_gpu_preset: String::new(),
            fingerprint_resolution_preset: String::new(),
            dm_img_str: String::new(),
            dm_cover_img_str: String::new(),
            dm_img_list: String::new(),
            dm_img_inter: String::new(),
            request_delay_ms: default_request_delay_ms(),
            download_danmaku: false,
            download_subtitle: false,
            danmaku_font_size: default_dm_font_size(),
            danmaku_scroll_duration: default_dm_scroll_duration(),
            danmaku_opacity: default_dm_opacity(),
            danmaku_block_top: false,
            danmaku_block_bottom: false,
            subtitle_format: default_subtitle_format(),
            download_nfo: false,
            nfo_include_genre: default_nfo_include_genre(),
            nfo_include_actor: default_nfo_include_actor(),
            nfo_include_stats: default_nfo_include_stats(),
        }
    }
}

impl AppSettings {
    /// 将设置中的弹幕渲染参数映射为 `DanmakuOption`（其余字段用默认值）。
    /// 供 download_extras 在下载弹幕时构造 ASS 渲染配置。
    pub fn to_danmaku_option(&self) -> crate::bilibili::danmaku::DanmakuOption {
        let mut opt = crate::bilibili::danmaku::DanmakuOption::default();
        opt.font_size = self.danmaku_font_size;
        opt.duration = self.danmaku_scroll_duration;
        opt.opacity = self.danmaku_opacity;
        opt.block_top = self.danmaku_block_top;
        opt.block_bottom = self.danmaku_block_bottom;
        opt
    }

    /// 字幕导出格式归一化为 "srt" 或 "vtt"（非法值回退 srt）
    pub fn normalized_subtitle_format(&self) -> &str {
        if self.subtitle_format.eq_ignore_ascii_case("vtt") {
            "vtt"
        } else {
            "srt"
        }
    }
}

// ==================== 持久化 ====================

fn settings_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("settings.json")
}

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    let path = settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // 先尝试新格式，失败则用旧格式迁移
    match serde_json::from_str::<AppSettings>(&content) {
        Ok(settings) => Ok(settings),
        Err(_) => {
            log::info!("[settings] 检测到旧格式设置，执行迁移");
            let legacy: LegacySettings =
                serde_json::from_str(&content).map_err(|e| format!("设置解析失败: {}", e))?;
            let migrated = AppSettings::from(legacy);
            // 自动保存迁移后的新格式
            if let Ok(new_content) = serde_json::to_string_pretty(&migrated) {
                let _ = std::fs::write(&path, new_content);
            }
            Ok(migrated)
        }
    }
}

#[tauri::command]
pub fn save_settings(settings: AppSettings) -> Result<(), String> {
    let path = settings_path();
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // 原子写入：先写临时文件再 rename，防止崩溃导致数据丢失
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|e| {
        // rename 失败时尝试清理临时文件
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    Ok(())
}

/// 获取 GPU 预设选项列表
#[tauri::command]
pub fn get_gpu_presets() -> Vec<(String, String)> {
    fingerprint::get_gpu_preset_options()
}

/// 获取分辨率预设选项列表
#[tauri::command]
pub fn get_resolution_presets() -> Vec<(String, String)> {
    fingerprint::get_resolution_preset_options()
}

/// 生成设备指纹
#[tauri::command]
pub fn generate_fingerprint_cmd(gpu_preset: String, resolution_preset: String) -> Result<Fingerprint, String> {
    fingerprint::generate_fingerprint(&gpu_preset, &resolution_preset)
}

/// 随机生成默认指纹
#[tauri::command]
pub fn generate_random_fingerprint() -> Fingerprint {
    fingerprint::generate_default_fingerprint()
}
