use tauri::Emitter;
use crate::bilibili::credential::Credential;
use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";
const MAX_RETRIES: usize = 3;

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

/// 构建视频流下载请求头
fn create_download_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
    headers.insert("Referer", HeaderValue::from_static(REFERER));
    headers.insert("Accept", HeaderValue::from_static("*/*"));
    headers.insert(
        "Accept-Language",
        HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
    );
    headers.insert(
        "sec-ch-ua",
        HeaderValue::from_static(
            "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        ),
    );
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert(
        "sec-ch-ua-platform",
        HeaderValue::from_static("\"Windows\""),
    );
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    headers
}

/// 创建带超时的 HTTP 客户端
fn download_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(false)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .context("创建HTTP客户端失败")
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
    let truncated: String = sanitized.chars().take(200).collect();
    truncated.trim().to_string()
}

/// 下载单个流到临时文件（支持多 URL 回退 + 重试）
pub async fn download_stream(
    app: &AppHandle,
    download_id: &str,
    urls: &[String],
    credential: &Credential,
    temp_dir: &Path,
    stream_label: &str,
) -> Result<PathBuf> {
    let client = download_client()?;
    let extension = if stream_label == "video" {
        "video.tmp"
    } else {
        "audio.tmp"
    };
    let temp_path = temp_dir.join(format!("{}.{}", download_id, extension));

    let mut last_error = String::new();

    // 依次尝试所有 URL（主 URL + 备用 URL）
    for (url_idx, url) in urls.iter().enumerate() {
        for retry in 0..=MAX_RETRIES {
            match download_single(
                &client,
                app,
                download_id,
                url,
                credential,
                &temp_path,
                stream_label,
            )
            .await
            {
                Ok(()) => {
                    // 下载完成，验证文件大小
                    let metadata =
                        tokio::fs::metadata(&temp_path)
                            .await
                            .context("读取下载文件信息失败")?;
                    if metadata.len() < 1024 {
                        // 小于 1KB 可能是错误页面
                        last_error = "下载文件过小，可能是错误响应".to_string();
                        let _ = tokio::fs::remove_file(&temp_path).await;
                        break; // 换下一个 URL
                    }
                    return Ok(temp_path.clone());
                }
                Err(e) => {
                    last_error = format!(
                        "URL#{} 重试#{}: {}",
                        url_idx,
                        retry,
                        e
                    );
                    if retry < MAX_RETRIES {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * (retry as u64 + 1)))
                            .await;
                    }
                }
            }
        }
    }

    anyhow::bail!(
        "下载 {} 流失败（已尝试所有URL和重试）: {}",
        stream_label,
        last_error
    )
}

/// 下载单个 URL 到文件
async fn download_single(
    client: &reqwest::Client,
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    stream_label: &str,
) -> Result<()> {
    let response = client
        .get(url)
        .headers(create_download_headers())
        .header("Cookie", credential.cookie_header())
        .send()
        .await
        .context("请求视频流失败")?;

    if !response.status().is_success() {
        anyhow::bail!("视频流请求失败: HTTP {}", response.status());
    }

    let total_size = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(temp_path)
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
        if downloaded - last_report >= report_interval
            || (total_size > 0 && downloaded >= total_size)
        {
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
    Ok(())
}

/// 使用 ffmpeg 合并视频和音频流
pub async fn merge_streams(
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<()> {
    // 合并前验证文件存在且大小合理
    validate_temp_file(video_path, "视频").await?;
    validate_temp_file(audio_path, "音频").await?;

    let ffmpeg = resolve_ffmpeg_path();

    // 确保输出目录存在
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("创建输出目录失败")?;
    }

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
        .context(format!("执行ffmpeg失败，内置ffmpeg可能缺失。当前路径: {}", ffmpeg))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg合并失败: {}", stderr);
    }

    Ok(())
}

/// 使用 ffmpeg 将 FLV/durl 等旧格式转封装为 MP4
pub async fn remux_to_mp4(
    input_path: &Path,
    output_path: &Path,
) -> Result<()> {
    validate_temp_file(input_path, "视频").await?;

    let ffmpeg = resolve_ffmpeg_path();

    // 确保输出目录存在
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("创建输出目录失败")?;
    }

    let output = tokio::process::Command::new(&ffmpeg)
        .args([
            "-i",
            input_path.to_str().unwrap_or(""),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-y",
            output_path.to_str().unwrap_or(""),
        ])
        .output()
        .await
        .context(format!("执行ffmpeg转封装失败，内置ffmpeg可能缺失。当前路径: {}", ffmpeg))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg转封装失败: {}", stderr);
    }

    Ok(())
}

/// 验证临时文件是否存在且大小合理
async fn validate_temp_file(path: &Path, label: &str) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("{}临时文件不存在: {:?}", label, path);
    }
    let metadata = tokio::fs::metadata(path).await?;
    if metadata.len() < 1024 {
        anyhow::bail!("{}临时文件过小 ({} bytes)，可能下载不完整", label, metadata.len());
    }
    Ok(())
}

/// 解析 ffmpeg 路径
/// 优先级：exe 同目录内置 > 系统 PATH
fn resolve_ffmpeg_path() -> String {
    // 1. 尝试 exe 同目录下的内置 ffmpeg.exe
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let bundled = parent.join("ffmpeg.exe");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }

    // 2. 兜底使用系统 PATH
    "ffmpeg".to_string()
}

/// 清理临时文件
pub async fn cleanup_temp_files(paths: &[PathBuf]) {
    for path in paths {
        if let Err(e) = tokio::fs::remove_file(path).await {
            log::warn!("清理临时文件失败 {:?}: {}", path, e);
        }
    }
}
