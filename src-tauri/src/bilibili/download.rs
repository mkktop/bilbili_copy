use tauri::Emitter;
use crate::bilibili::credential::Credential;
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";

/// 下载进度事件载荷
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub label: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
}

/// 下载完成事件载荷
#[derive(Clone, Serialize)]
pub struct DownloadComplete {
    pub id: String,
    pub output_path: String,
}

/// 下载错误事件载荷
#[derive(Clone, Serialize)]
pub struct DownloadError {
    pub id: String,
    pub error: String,
}

/// 清理文件名中的非法字符
pub fn sanitize_filename(title: &str) -> String {
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' => '_',
            _ => c,
        })
        .collect();
    // 截断到200字符
    let truncated: String = sanitized.chars().take(200).collect();
    truncated.trim().to_string()
}

/// 下载单个流到临时文件，带进度事件
pub async fn download_stream(
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_dir: &Path,
    stream_label: &str,
) -> Result<PathBuf> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .build()
        .context("创建HTTP客户端失败")?;

    let response = client
        .get(url)
        .header("Referer", REFERER)
        .header("Cookie", credential.cookie_header())
        .send()
        .await
        .context("请求视频流失败")?;

    if !response.status().is_success() {
        anyhow::bail!("视频流请求失败: HTTP {}", response.status());
    }

    let total_size = response.content_length().unwrap_or(0);
    let extension = if stream_label == "video" { "video.tmp" } else { "audio.tmp" };
    let temp_path = temp_dir.join(format!("{}.{}", download_id, extension));

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .context("创建临时文件失败")?;

    let mut downloaded: u64 = 0;
    let mut last_report: u64 = 0;
    let report_interval: u64 = 512 * 1024; // 每512KB报告一次

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("读取流数据失败")?;
        file.write_all(&chunk).await.context("写入临时文件失败")?;
        downloaded += chunk.len() as u64;

        // 每512KB或完成时报告进度
        if downloaded - last_report >= report_interval || (total_size > 0 && downloaded >= total_size) {
            let percent = if total_size > 0 {
                (downloaded as f64 / total_size as f64) * 100.0
            } else {
                0.0
            };

            let _ = app.emit(
                "download://progress",
                DownloadProgress {
                    id: download_id.to_string(),
                    label: stream_label.to_string(),
                    downloaded,
                    total: total_size,
                    percent,
                },
            );

            last_report = downloaded;
        }
    }

    file.flush().await.context("刷新文件失败")?;
    Ok(temp_path)
}

/// 使用 ffmpeg 合并视频和音频流
pub async fn merge_streams(
    ffmpeg_path: &str,
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<()> {
    let ffmpeg = if ffmpeg_path.is_empty() {
        "ffmpeg".to_string()
    } else {
        ffmpeg_path.to_string()
    };

    let output = tokio::process::Command::new(&ffmpeg)
        .args([
            "-i",
            video_path.to_str().unwrap_or(""),
            "-i",
            audio_path.to_str().unwrap_or(""),
            "-c",
            "copy",
            "-strict",
            "unofficial",
            "-y",
            output_path.to_str().unwrap_or(""),
        ])
        .output()
        .await
        .context(format!(
            "执行ffmpeg失败，请确认ffmpeg已安装。如已安装，请在设置中配置ffmpeg路径。当前路径: {}",
            ffmpeg
        ))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg合并失败: {}", stderr);
    }

    Ok(())
}

/// 清理临时文件
pub async fn cleanup_temp_files(paths: &[PathBuf]) {
    for path in paths {
        if let Err(e) = tokio::fs::remove_file(path).await {
            eprintln!("清理临时文件失败 {:?}: {}", path, e);
        }
    }
}
