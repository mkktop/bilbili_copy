use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::Semaphore;

use crate::bilibili::credential::Credential;
use crate::bilibili::download::{
    cleanup_temp_files, download_stream, merge_streams, remux_to_mp4, sanitize_filename,
    DownloadComplete, DownloadError,
};
use crate::bilibili::playurl::get_playurl;
use crate::commands::settings::get_settings;
use tauri::AppHandle;

// ==================== Feature 3: 全局下载并发限制 ====================
const MAX_GLOBAL_DOWNLOADS: usize = 2;
static DOWNLOAD_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(MAX_GLOBAL_DOWNLOADS));

// ==================== Feature 4: 分P独立并发限制 ====================
const MAX_PAGES_PER_VIDEO: usize = 2;
static VIDEO_SEMAPHORES: Lazy<Mutex<HashMap<String, Arc<Semaphore>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 获取指定 bvid 的 per-video Semaphore
fn get_video_semaphore(bvid: &str) -> Arc<Semaphore> {
    let mut map = VIDEO_SEMAPHORES.lock().unwrap();
    map.entry(bvid.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_PAGES_PER_VIDEO)))
        .clone()
}

/// 清理无持有者的 per-video Semaphore（防止内存泄漏）
fn cleanup_video_semaphore(bvid: &str) {
    let mut map = VIDEO_SEMAPHORES.lock().unwrap();
    if let Some(sem) = map.get(bvid) {
        // 如果 Semaphore 的可用 permit 数 == 最大值，说明没人持有
        if sem.available_permits() == MAX_PAGES_PER_VIDEO {
            map.remove(bvid);
        }
    }
}

#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    id: String,
    bvid: String,
    cid: i64,
    title: String,
    qn: Option<i64>,
) -> Result<(), String> {
    let download_id = id;

    // Feature 3: 获取全局下载 permit
    let _global_permit = DOWNLOAD_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| format!("获取下载许可失败: {}", e))?;

    // Feature 4: 获取 per-video 分P permit
    let video_sem = get_video_semaphore(&bvid);
    let _video_permit = video_sem
        .acquire()
        .await
        .map_err(|e| format!("获取分P下载许可失败: {}", e))?;

    log::info!(
        "[download] 获得并发许可: id={}, 全局可用={}, 视频{}可用={}",
        download_id,
        DOWNLOAD_SEMAPHORE.available_permits(),
        bvid,
        video_sem.available_permits()
    );

    // 1. 加载凭证（必须已登录）
    let credential = Credential::load()
        .map_err(|_| "请先登录".to_string())?
        .ok_or_else(|| "请先登录".to_string())?;

    // 2. 加载设置
    let settings = get_settings().map_err(|e| e.to_string())?;

    // 2.5 画质参数
    let video_max_qn = qn.unwrap_or(settings.video_max_quality);
    let video_min_qn = settings.video_min_quality;
    let audio_max_qn = settings.audio_max_quality;
    let audio_min_qn = settings.audio_min_quality;
    let codec_priority = settings.video_codec_priority;

    // 3. 确定下载目录
    let download_dir = if settings.default_download_dir.is_empty() {
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("获取exe路径失败: {}", e))?
            .parent()
            .map(|p| p.join("downloads"))
            .ok_or_else(|| "无法确定下载目录".to_string())?;
        std::fs::create_dir_all(&exe_dir)
            .map_err(|e| format!("创建下载目录失败: {}", e))?;
        exe_dir
    } else {
        let dir = std::path::PathBuf::from(&settings.default_download_dir);
        if !dir.exists() {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("创建下载目录失败: {}", e))?;
        }
        dir
    };

    // 4. 构建输出文件路径
    let filename = format!("{}.mp4", sanitize_filename(&title));
    let output_path = download_dir.join(&filename);

    // 执行下载流程
    let result = run_download(
        &app,
        &download_id,
        &bvid,
        cid,
        video_max_qn,
        video_min_qn,
        audio_max_qn,
        audio_min_qn,
        &codec_priority,
        &credential,
        &download_dir,
        &output_path,
    )
    .await;

    // 清理 per-video semaphore（_video_permit 和 _global_permit 在函数返回时自动释放）
    cleanup_video_semaphore(&bvid);

    match result {
        Ok(()) => {
            log::info!(
                "[download] 下载完成: id={}, path={}",
                download_id,
                output_path.display()
            );
            let _ = app.emit(
                "download://complete",
                DownloadComplete {
                    id: download_id,
                    output_path: output_path.to_string_lossy().to_string(),
                },
            );
            Ok(())
        }
        Err(e) => {
            let error_msg = e.to_string();
            log::error!(
                "[download] 下载失败: id={}, error={}",
                download_id,
                error_msg
            );
            let _ = app.emit(
                "download://error",
                DownloadError {
                    id: download_id,
                    error: error_msg.clone(),
                },
            );
            Err(error_msg)
        }
    }
}

async fn run_download(
    app: &AppHandle,
    download_id: &str,
    bvid: &str,
    cid: i64,
    video_max_qn: i64,
    video_min_qn: i64,
    audio_max_qn: i64,
    audio_min_qn: i64,
    codec_priority: &[String],
    credential: &Credential,
    temp_dir: &std::path::Path,
    output_path: &std::path::Path,
) -> anyhow::Result<()> {
    // 5. 获取视频流地址
    log::info!(
        "[download] 开始获取流地址: id={}, bvid={}, cid={}",
        download_id, bvid, cid
    );
    let streams = get_playurl(
        bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority,
    ).await?;
    log::info!(
        "[download] 流地址获取成功: id={}, legacy={}, has_audio={}, video_urls={}, audio_urls={}",
        download_id, streams.is_legacy_format, streams.has_audio(),
        streams.video_urls.len(), streams.audio_urls.len()
    );

    let mut temp_files: Vec<std::path::PathBuf> = Vec::new();

    // 用闭包封装实际逻辑，确保无论成功失败都清理临时文件
    let result = async {
        if streams.is_legacy_format {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir, "video",
            ).await?;
            temp_files.push(video_temp.clone());
            remux_to_mp4(&video_temp, output_path).await?;
        } else if streams.has_audio() {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir, "video",
            ).await?;
            temp_files.push(video_temp.clone());
            let audio_temp = download_stream(
                app, download_id, &streams.audio_urls, credential, temp_dir, "audio",
            ).await?;
            temp_files.push(audio_temp.clone());
            merge_streams(&video_temp, &audio_temp, output_path).await?;
        } else {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir, "video",
            ).await?;
            temp_files.push(video_temp.clone());
            tokio::fs::rename(&video_temp, output_path).await?;
            temp_files.pop(); // 文件已重命名，不需要清理
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    // 无论成功失败都清理临时文件
    cleanup_temp_files(&temp_files).await;

    result
}
