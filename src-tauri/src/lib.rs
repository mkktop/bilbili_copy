mod commands;
mod bilibili;

use commands::settings::{get_settings, save_settings};
use commands::video::parse_video;
use commands::download::download_video;
use commands::login::{login_generate_qrcode, login_poll_qrcode, login_check, login_logout};

/// Read Windows system proxy settings and set HTTPS_PROXY env var
/// so the Tauri updater (reqwest) can use the system proxy.
#[cfg(target_os = "windows")]
fn init_system_proxy() {
    use std::env;

    // Only set if not already configured by the user
    if env::var("HTTPS_PROXY").is_ok() || env::var("https_proxy").is_ok() {
        return;
    }

    // Read Windows system proxy from registry
    let proxy_enabled = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()
        .and_then(|key| key.get_value::<u32, _>("ProxyEnable").ok())
        .unwrap_or(0);

    if proxy_enabled == 0 {
        return;
    }

    let proxy_server: Option<String> = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()
        .and_then(|key| key.get_value("ProxyServer").ok());

    if let Some(server) = proxy_server {
        let proxy_url = if server.starts_with("http") {
            server
        } else {
            format!("http://{}", server)
        };
        env::set_var("HTTPS_PROXY", &proxy_url);
        env::set_var("HTTP_PROXY", &proxy_url);
    }
}

#[cfg(not(target_os = "windows"))]
fn init_system_proxy() {}

/// 初始化日志系统，日志文件写到 exe 同目录下
fn init_logger() {
    use simplelog::*;

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let log_path = exe_dir.join("app.log");

    // 创建日志文件（追加模式）
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("无法创建日志文件 {:?}: {}", log_path, e);
            return;
        }
    };

    let config = ConfigBuilder::new()
        .set_thread_mode(ThreadLogMode::Both)
        .build();

    let _ = CombinedLogger::init(vec![
        TermLogger::new(LevelFilter::Warn, config.clone(), TerminalMode::Mixed, ColorChoice::Auto),
        WriteLogger::new(LevelFilter::Debug, config, file),
    ]);

    log::info!("========== 应用启动 ==========");
}

pub fn run() {
    init_logger();
    init_system_proxy();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            parse_video,
            download_video,
            login_generate_qrcode,
            login_poll_qrcode,
            login_check,
            login_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
