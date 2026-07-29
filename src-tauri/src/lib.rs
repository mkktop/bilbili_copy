mod commands;
mod bilibili;
mod db;
mod download_manager;

use commands::settings::{get_settings, save_settings, get_gpu_presets, get_resolution_presets, generate_fingerprint_cmd, generate_random_fingerprint, load_settings, store_settings};
use tauri::Manager;
use commands::video::parse_video;
use commands::download::{download_video, pause_download, cancel_download, set_download_priority};
use commands::login::{login_generate_qrcode, login_poll_qrcode, login_check, login_logout};
use commands::risk_control::{captcha_register, captcha_validate};
use commands::history::{
    get_parse_history, save_parse_history, delete_parse_history, get_parse_count, clear_parse_history, touch_parse_history,
    get_download_history, save_download_entry, update_download_status, delete_download_history, get_download_count, clear_download_history, get_download_stats,
    get_play_progress, save_play_progress,
};
use commands::favorite::{get_favorite_folders, get_favorite_videos};
use commands::watch_later::get_watch_later;
use commands::search::{search_videos, get_hot_search, get_search_history, save_search_keyword, delete_search_keyword, clear_search_history};
use commands::submission::{get_upper_info, get_submission_videos};
use commands::collection::{get_upper_collections, get_collection_videos, get_subscribed_collections};
use commands::following::get_followings;
use commands::history_cmd::get_watch_history;
use commands::ranking::get_ranking;
use commands::pgc::{get_pgc_rank, get_bangumi_follow};
use commands::recommend::get_recommend;
use commands::region::get_region;
use commands::comment::get_video_comments;
use commands::dynamic::get_dynamic_feed;
use commands::article::{get_article_content, export_article_markdown};
use commands::interaction::{like_video, coin_video, favorite_video};
use commands::player::{get_play_streams, get_danmaku_json, get_subtitle_list, get_subtitle_cues, log_player_error, get_seek_index};
use commands::weekly::{get_weekly_series, get_weekly_detail};
use download_manager::manager;

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

    // 用 LineWriter 包装，确保每行日志立即刷盘（避免缓冲导致看不到关键日志）
    let line_writer = std::io::LineWriter::new(file);

    let _ = CombinedLogger::init(vec![
        TermLogger::new(LevelFilter::Warn, config.clone(), TerminalMode::Mixed, ColorChoice::Auto),
        // 文件日志使用 INFO 级别：DEBUG（每个分片/每个进度 tick 都会记录）会让日志文件无限膨胀。
        // 排查问题时可临时改回 LevelFilter::Debug。
        WriteLogger::new(LevelFilter::Info, config, line_writer),
    ]);

    log::info!("========== 应用启动 ==========");
    log::logger().flush();
}

/// 池化的代理 HTTP client：keep-alive 复用连接，避免每个 2MB 分块都重新 TCP+TLS 握手到 B站 CDN。
/// （旧版每块 new 一个 client → 上百块每块多 ~100-300ms 握手，严重拖慢缓冲 / 起播 / 切画质追帧。）
static PROXY_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(bilibili::USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .cookie_store(false) // 与代码库约定一致：按请求手动带 Cookie，不开 jar 避免污染
        .build()
        .expect("代理 HTTP client 创建失败")
});

/// biliproxy 自定义协议处理：
/// 前端 fetch("http://biliproxy.localhost/b/<base64url(B站url)>") →
/// 这里带 Referer+Cookie 透传 Range，把字节回灌给前端 MSE
/// （解决浏览器跨域拿不到 B站流 + B站要求 Referer 头两个问题）。
async fn biliproxy_fetch(
    request: tauri::http::Request<Vec<u8>>,
) -> anyhow::Result<tauri::http::Response<std::borrow::Cow<'static, [u8]>>> {
    use base64::Engine;
    // 路径形如 /b/<base64url>，取最后一段解码出 B站 原始 URL
    let path = request.uri().path();
    let b64 = path.rsplit('/').next().unwrap_or("");
    let bili_url = String::from_utf8(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64.trim_end_matches('='))?,
    )?;

    // 透传 Range（MSE 分块请求）
    let range = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // 复用池化 client：同 host 连续分块复用 TCP+TLS 连接，省掉每块握手
    let cred = bilibili::credential::Credential::load().ok().flatten();
    let mut req = PROXY_CLIENT
        .get(&bili_url)
        .header("Referer", bilibili::REFERER)
        .header("Origin", bilibili::ORIGIN);
    if let Some(r) = &range {
        req = req.header("Range", r);
    }
    if let Some(c) = cred.as_ref() {
        req = req.header("Cookie", c.cookie_header());
    }
    let resp = req.send().await?;
    let status = resp.status();
    // 透传与范围/类型相关的头，补 CORS + 断点续传支持
    let mut builder = tauri::http::Response::builder()
        .status(status.as_u16())
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        // 暴露 Range 相关头给 JS：否则 MSE 侧 res.headers.get("content-range") 读不到 → 无法判断文件总长
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    for (k, v) in resp.headers().iter() {
        if matches!(
            k.as_str(),
            "content-type" | "content-length" | "content-range" | "last-modified" | "etag"
        ) {
            builder = builder.header(k, v);
        }
    }
    let body = resp.bytes().await?.to_vec();
    Ok(builder.body(std::borrow::Cow::Owned(body))?)
}

/// 用池化代理 client 取 B站 流的某段字节（带 Referer/Cookie，复用 keep-alive 连接）。
/// 供 mp4_seek 后端直连解析 moov 复用（不经前端 webview 代理）。
pub(crate) async fn proxy_fetch_bytes(url: &str, start: u64, end_inclusive: u64) -> anyhow::Result<Vec<u8>> {
    let cred = bilibili::credential::Credential::load().ok().flatten();
    let mut req = PROXY_CLIENT
        .get(url)
        .header("Referer", bilibili::REFERER)
        .header("Origin", bilibili::ORIGIN)
        .header("Range", format!("bytes={start}-{end_inclusive}"));
    if let Some(c) = cred.as_ref() {
        req = req.header("Cookie", c.cookie_header());
    }
    let resp = req.send().await?.error_for_status()?;
    Ok(resp.bytes().await?.to_vec())
}

pub fn run() {
    init_logger();
    init_system_proxy();

    let db_state = db::init_db().expect("数据库初始化失败");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(db_state)
        // biliproxy：B站流代理协议。前端经它拉取流字节喂给 MSE（补 Referer、绕跨域、透传 Range）
        .register_asynchronous_uri_scheme_protocol("biliproxy", |_app, request, responder| {
            tauri::async_runtime::spawn(async move {
                let resp = biliproxy_fetch(request).await.unwrap_or_else(|e| {
                    log::warn!("[biliproxy] 代理失败: {}", e);
                    tauri::http::Response::builder()
                        .status(502)
                        .header("content-type", "text/plain; charset=utf-8")
                        .body(std::borrow::Cow::Borrowed(&b"proxy error"[..]))
                        .unwrap()
                });
                responder.respond(resp);
            });
        })
        .setup(|app| {
            // 启动下载调度器 dispatcher 后台循环。常驻运行：
            // pop 最高优先级任务 → acquire permit → spawn 执行 → 处理 pause/cancel/优先级。
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                manager().run_dispatcher(app_handle).await;
            });

            // ==================== 系统托盘 ====================
            // 关闭窗口时拦截 → 隐藏到托盘（后台下载继续）。托盘菜单提供「显示主窗口」「退出」。
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_i = MenuItem::with_id(app, "tray_show", "显示主窗口", true, None::<&str>)?;
            let sep_i = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &sep_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("缺少窗口图标"))
                .tooltip("BilbliCopy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_quit" => {
                        // 绕过 CloseRequested 拦截，真正退出
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击 / 双击 → 显示窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_gpu_presets,
            get_resolution_presets,
            generate_fingerprint_cmd,
            generate_random_fingerprint,
            parse_video,
            download_video,
            pause_download,
            cancel_download,
            set_download_priority,
            login_generate_qrcode,
            login_poll_qrcode,
            login_check,
            login_logout,
            captcha_register,
            captcha_validate,
            get_parse_history,
            get_parse_count,
            save_parse_history,
            delete_parse_history,
            clear_parse_history,
            touch_parse_history,
    get_download_history,
    get_download_count,
    get_download_stats,
    save_download_entry,
            update_download_status,
            delete_download_history,
            clear_download_history,
            get_favorite_folders,
            get_favorite_videos,
            get_watch_later,
            search_videos,
            get_hot_search,
            get_search_history,
            save_search_keyword,
            delete_search_keyword,
            clear_search_history,
            get_upper_info,
            get_submission_videos,
            get_upper_collections,
            get_collection_videos,
            get_subscribed_collections,
            get_followings,
            get_watch_history,
            get_ranking,
            get_pgc_rank,
            get_bangumi_follow,
            get_recommend,
            get_region,
            get_video_comments,
            get_dynamic_feed,
            get_article_content,
            export_article_markdown,
            get_play_progress,
            save_play_progress,
            like_video,
            coin_video,
            favorite_video,
            get_play_streams,
            get_danmaku_json,
            get_subtitle_list,
            get_subtitle_cues,
            log_player_error,
            get_seek_index,
            get_weekly_series,
            get_weekly_detail,
        ])
        .on_window_event(|window, event| {
            // 拦截主窗口关闭：根据设置决定是「最小化到托盘」还是「正常退出」。
            // 下载调度器是独立后台任务，窗口隐藏后下载照常进行；
            // 只有这里放行（不调 prevent_close）或托盘「退出」才会真正退出进程。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let settings = load_settings();
                if settings.close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();

                    // 首次最小化时弹一次系统通知，告知后台继续运行（之后不再提示）
                    if !settings.tray_hint_shown {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = window.app_handle().notification()
                            .builder()
                            .title("BilbliCopy 已最小化到托盘")
                            .body("程序在后台继续运行，下载任务不会中断。点击托盘图标可恢复窗口。")
                            .show();
                        let mut s = settings;
                        s.tray_hint_shown = true;
                        let _ = store_settings(&s);
                    }
                }
                // close_to_tray == false 时不阻止，窗口正常关闭 → 进程退出
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
