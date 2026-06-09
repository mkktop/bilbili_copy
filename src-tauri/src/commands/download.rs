use tauri::Emitter;
use crate::bilibili::credential::Credential;
use crate::bilibili::download::{
    cleanup_temp_files, download_stream, merge_streams, sanitize_filename, DownloadComplete,
    DownloadError,
};
use crate::bilibili::playurl::get_playurl;
use crate::commands::settings::get_settings;
use tauri::AppHandle;

#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    bvid: String,
    cid: i64,
    title: String,
) -> Result<(), String> {
    let download_id = format!("{}_{}", bvid, cid);

    // 1. 加载凭证（必须已登录）
    let credential = Credential::load()
        .map_err(|_| "请先登录".to_string())?
        .ok_or_else(|| "请先登录".to_string())?;

    // 2. 加载设置
    let settings = get_settings().map_err(|e| e.to_string())?;

    // 3. 确定下载目录
    let download_dir = if settings.default_download_dir.is_empty() {
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("获取exe路径失败: {}", e))?
            .parent()
            .map(|p| p.join("downloads"))
            .ok_or_else(|| "无法确定下载目录".to_string())?;
        // 确保目录存在
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
        &credential,
        &download_dir,
        &output_path,
        &settings.ffmpeg_path,
    )
    .await;

    match result {
        Ok(()) => {
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
    credential: &Credential,
    temp_dir: &std::path::Path,
    output_path: &std::path::Path,
    ffmpeg_path: &str,
) -> anyhow::Result<()> {
    // 5. 获取视频流地址
    let streams = get_playurl(bvid, cid, credential).await?;

    // 6. 下载视频流
    let video_temp = download_stream(
        app,
        download_id,
        &streams.video_url,
        credential,
        temp_dir,
        "video",
    )
    .await?;

    // 7. 下载音频流（如果有）
    let mut temp_files = vec![video_temp.clone()];

    if let Some(audio_url) = &streams.audio_url {
        let audio_temp = download_stream(
            app,
            download_id,
            audio_url,
            credential,
            temp_dir,
            "audio",
        )
        .await?;
        temp_files.push(audio_temp.clone());

        // 8. 合并音视频
        merge_streams(ffmpeg_path, &video_temp, &audio_temp, output_path).await?;
    } else {
        // 无独立音频流，直接重命名视频文件
        tokio::fs::rename(&video_temp, output_path).await?;
    }

    // 9. 清理临时文件
    cleanup_temp_files(&temp_files).await;

    Ok(())
}
