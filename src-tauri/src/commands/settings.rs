use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ==================== 默认值函数 ====================

fn default_video_max_quality() -> i64 {
    127 // 8K
}

fn default_video_min_quality() -> i64 {
    0 // 不限制
}

fn default_audio_max_quality() -> i64 {
    30280 // 192K
}

fn default_audio_min_quality() -> i64 {
    0 // 不限制
}

fn default_codec_priority() -> Vec<String> {
    vec!["AVC".into(), "HEV".into(), "AV1".into()]
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
            audio_max_quality: legacy.audio_max_quality.unwrap_or(30280),
            audio_min_quality: legacy.audio_min_quality.unwrap_or(0),
            video_codec_priority: legacy
                .video_codec_priority
                .unwrap_or_else(default_codec_priority),
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
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}
