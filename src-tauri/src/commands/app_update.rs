//! 应用自更新：按设置中的更新渠道（R2 / GitHub）检查、下载并安装。
//!
//! tauri-plugin-updater 的 JS API 不支持运行时切换 endpoint，因此检查/下载/安装
//! 都走这里的自定义命令：按渠道选择 latest.json 端点列表，下载进度通过
//! `update://progress` 事件推给前端（含实际命中渠道与速度）。

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::UpdaterExt;

/// R2 渠道 latest.json（CI 发版时与安装包一起上传到桶根目录）
const R2_LATEST_JSON: &str = "https://copy.kaikun.top/latest.json";
/// R2 渠道兜底：r2.dev 直连桶域名（自定义域名故障时仍可拉取，低频更新场景可接受）
const R2_DEV_LATEST_JSON: &str =
    "https://pub-9ad8f47e95c54818b4c9c3dd2b3cb0b2.r2.dev/latest.json";
/// GitHub 渠道 latest.json
const GITHUB_LATEST_JSON: &str =
    "https://github.com/mkktop/bilbili_copy/releases/latest/download/latest.json";

/// 各渠道的 latest.json 端点，按优先级排列（插件按序尝试直到成功）。
fn endpoints_for_channel(channel: &str) -> Vec<Url> {
    let parse = |s: &str| s.parse().expect("内置更新端点必须是合法 URL");
    match channel {
        // 显式选 GitHub：仅用 GitHub（选它通常就是为了绕开 R2）
        "github" => vec![parse(GITHUB_LATEST_JSON)],
        // 默认 R2 优先：自定义域 → r2.dev → GitHub
        _ => vec![
            parse(R2_LATEST_JSON),
            parse(R2_DEV_LATEST_JSON),
            parse(GITHUB_LATEST_JSON),
        ],
    }
}

/// 从 latest.json 下发的安装包 URL 推断实际生效渠道（端点回退后与设置可能不同）
fn channel_of_download_url(url: &Url) -> &'static str {
    match url.host_str().unwrap_or_default() {
        h if h.contains("github") => "github",
        _ => "r2",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    /// 实际命中的渠道："r2" | "github"
    pub channel: String,
}

fn build_updater(
    app: &AppHandle,
    channel: &str,
    timeout: Option<Duration>,
) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    builder
        .endpoints(endpoints_for_channel(channel))
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// 检查更新；返回 None 表示已是最新版本。
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    channel: String,
) -> Result<Option<AppUpdateInfo>, String> {
    let update = build_updater(&app, &channel, Some(Duration::from_secs(30)))?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| AppUpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        pub_date: u.date.map(|d| d.to_string()),
        channel: channel_of_download_url(&u.download_url).to_string(),
    }))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    /// 字节/秒（指数平滑，约 200ms 刷新一次）
    speed: u64,
    channel: &'static str,
}

/// 下载并安装更新，成功后应用自动重启。
/// 下载进度通过 `update://progress` 事件推送；下载完成先发 `update://downloaded`。
/// 检查用短超时快速回退端点；下载阶段不设 30s 级短超时，避免慢网下安装包拉不完。
#[tauri::command]
pub async fn install_app_update(app: AppHandle, channel: String) -> Result<(), String> {
    let update = build_updater(&app, &channel, Some(Duration::from_secs(30)))?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("当前已是最新版本")?;

    let channel = channel_of_download_url(&update.download_url);

    // 用不设短超时的 updater 重新构建下载会话（check 只多拉一次几 KB 的 latest.json）
    let update = build_updater(&app, &channel, Some(Duration::from_secs(600)))?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("当前已是最新版本")?;

    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_downloaded: u64 = 0;
    let mut smooth_speed: f64 = 0.0;

    let emitter = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let dt = last_emit.elapsed().as_secs_f64();
                if dt >= 0.2 {
                    let instant = (downloaded - last_downloaded) as f64 / dt;
                    smooth_speed = if smooth_speed == 0.0 {
                        instant
                    } else {
                        smooth_speed * 0.6 + instant * 0.4
                    };
                    last_emit = Instant::now();
                    last_downloaded = downloaded;
                    let _ = emitter.emit(
                        "update://progress",
                        UpdateProgress {
                            downloaded,
                            total,
                            speed: smooth_speed as u64,
                            channel,
                        },
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("update://downloaded", channel);
    update.install(&bytes).map_err(|e| e.to_string())?;
    // MSI 安装可能直接接管/结束进程；能走到这里就主动重启进入新版本
    launch_rebranded_or_restart(&app);
    #[allow(unreachable_code)]
    Ok(())
}

/// 改名（BilbliCopy → 未雨）后 productName 变化导致 MSI UpgradeCode 变化，
/// 首次升级会装进同级的新目录（C:\Program Files\Weiyu）而非原地覆盖。
/// 安装完成后优先拉起新目录的 exe，避免用户「更新完重启又回到旧版」；
/// 自定义安装路径等找不到时，回退为重启当前 exe（数据迁移在新版首次启动时做）。
fn launch_rebranded_or_restart(app: &AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent().and_then(|p| p.parent()) {
            let candidate = parent.join("Weiyu").join("Weiyu.exe");
            if candidate.is_file() {
                if std::process::Command::new(&candidate).spawn().is_ok() {
                    log::info!("更新安装完成，已启动新版本: {:?}", candidate);
                    std::process::exit(0);
                }
                log::warn!("新版本 {:?} 拉起失败，回退为重启当前应用", candidate);
            }
        }
    }
    app.restart();
}
