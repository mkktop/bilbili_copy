use tauri::Emitter;
use crate::bilibili::credential::Credential;
use crate::bilibili::{USER_AGENT, REFERER};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const MAX_RETRIES: usize = 2;

// ==================== Feature 1: 并行下载常量 ====================
const MIN_PARALLEL_SIZE: u64 = 4 * 1024 * 1024; // 4MB 以下不分片
const MIN_SEGMENT_SIZE: u64 = 1 * 1024 * 1024; // 每片至少 1MB
const PARALLEL_THREADS: usize = 4; // 默认分片数

// ==================== Feature 2: 坏 CDN 节点缓存 ====================
const BAD_CDN_TTL: Duration = Duration::from_secs(600); // 10 分钟

static BAD_CDN_HOSTS: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 提取 URL 中的 host
fn extract_host(url: &str) -> Option<String> {
    url.split('/')
        .nth(2)
        .map(|h| h.split(':').next().unwrap_or(h).to_string())
}

/// 清理过期的坏节点记录
fn prune_expired(cache: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    cache.retain(|_, marked_at| now.duration_since(*marked_at) <= BAD_CDN_TTL);
}

/// 检查 URL 是否在坏节点黑名单中
fn is_bad_host(url: &str) -> bool {
    if let Some(host) = extract_host(url) {
        let mut cache = BAD_CDN_HOSTS.lock().unwrap();
        prune_expired(&mut cache);
        cache.contains_key(&host)
    } else {
        false
    }
}

/// 将 URL 标记为坏节点
fn mark_bad_host(url: &str) {
    if let Some(host) = extract_host(url) {
        let mut cache = BAD_CDN_HOSTS.lock().unwrap();
        prune_expired(&mut cache);
        let is_new = !cache.contains_key(&host);
        cache.insert(host.clone(), Instant::now());
        if is_new {
            log::warn!("[download] 标记坏CDN节点: {} (缓存{}分钟)", host, BAD_CDN_TTL.as_secs() / 60);
        }
    }
}

/// 检查错误是否为证书/连接类错误（应该标记为坏节点）
fn is_bad_host_error(err: &anyhow::Error) -> bool {
    let msg = format!("{:#}", err).to_ascii_lowercase();
    msg.contains("certificate")
        || msg.contains("tls")
        || msg.contains("ssl")
        || msg.contains("connect_timeout")
        || msg.contains("connection refused")
        || msg.contains("connection reset")
        || msg.contains("名称解析") // DNS
}

// ==================== 事件载荷 ====================

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

// ==================== HTTP 客户端 & 请求头 ====================

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
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .build()
        .context("创建HTTP客户端失败")
}

// ==================== Feature 5: 断点续传辅助 ====================

/// 获取已下载的临时文件大小（用于断点续传）
async fn get_existing_size(temp_path: &Path) -> u64 {
    match tokio::fs::metadata(temp_path).await {
        Ok(meta) if meta.len() > 0 => meta.len(),
        _ => 0,
    }
}

// ==================== 核心下载逻辑 ====================

/// 清理文件名中的非法字符（Windows 兼容）
pub fn sanitize_filename(title: &str) -> String {
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let truncated: String = sanitized.chars().take(200).collect();
    let result = truncated.trim_end_matches(|c: char| c == '.' || c == ' ');

    let upper = result.to_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.iter().any(|r| upper == *r) {
        return format!("{}_video", result);
    }

    result.to_string()
}

/// 下载单个流到临时文件
/// 支持：多 URL 回退 + 重试 + 坏节点缓存 + 断点续传 + Range 分片并行
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

    // Feature 5: 断点续传 — 检查已有文件大小
    let existing_size = get_existing_size(&temp_path).await;
    if existing_size > 0 {
        log::info!(
            "[download] {} 流检测到断点续传: id={}, 已有{}bytes",
            stream_label, download_id, existing_size
        );
    }

    // 依次尝试所有 URL（主 URL + 备用 URL）
    for (url_idx, url) in urls.iter().enumerate() {
        // Feature 2: 跳过坏节点
        if is_bad_host(url) {
            log::info!("[download] {} 流跳过坏CDN节点: id={}, host=URL#{}", stream_label, download_id, url_idx);
            continue;
        }

        for retry in 0..=MAX_RETRIES {
            match download_file(
                &client,
                app,
                download_id,
                url,
                credential,
                &temp_path,
                stream_label,
                existing_size,
            )
            .await
            {
                Ok(()) => {
                    // 下载完成，验证文件大小
                    let metadata = tokio::fs::metadata(&temp_path)
                        .await
                        .context("读取下载文件信息失败")?;
                    if metadata.len() < 1024 {
                        last_error = format!("下载文件过小 ({}bytes)", metadata.len());
                        log::warn!("[download] {} 流文件过小: id={}, size={}bytes", stream_label, download_id, metadata.len());
                        if let Ok(content) = tokio::fs::read_to_string(&temp_path).await {
                            log::debug!("[download] 错误响应内容: id={}, 内容={}", download_id, &content[..content.len().min(500)]);
                        }
                        let _ = tokio::fs::remove_file(&temp_path).await;
                        break;
                    }
                    return Ok(temp_path.clone());
                }
                Err(e) => {
                    // Feature 2: 标记坏节点
                    if is_bad_host_error(&e) {
                        mark_bad_host(url);
                    }
                    last_error = format!("URL#{} 重试#{}: {}", url_idx, retry, e);
                    log::warn!(
                        "[download] {} 流下载失败: id={}, {}, 将{}",
                        stream_label, download_id, last_error,
                        if retry < MAX_RETRIES {
                            format!("{}ms后重试", 500 * (retry as u64 + 1))
                        } else {
                            "尝试下一个URL".to_string()
                        }
                    );
                    if retry < MAX_RETRIES {
                        tokio::time::sleep(Duration::from_millis(500 * (retry as u64 + 1))).await;
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

/// 下载单个 URL 到文件（自动选择并行/单线程 + 支持断点续传）
async fn download_file(
    client: &reqwest::Client,
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    stream_label: &str,
    existing_size: u64, // Feature 5: 已有文件大小（0 = 全新下载）
) -> Result<()> {
    let url_host = url.split('/').nth(2).unwrap_or("unknown");
    log::info!("[download] {} 流开始下载: id={}, host={}", stream_label, download_id, url_host);

    // Feature 1: 先探测文件大小和 Range 支持
    let (total_size, range_supported) = probe_range_support(client, url, credential).await;

    // Feature 5: 断点续传 — 如果已有部分文件，调整起始位置
    let resume_from = if existing_size > 0 && range_supported && total_size > 0 && existing_size < total_size {
        log::info!(
            "[download] {} 流断点续传: id={}, 从{}bytes继续 (总{}bytes)",
            stream_label, download_id, existing_size, total_size
        );
        existing_size
    } else {
        0
    };

    // Feature 1: 判断是否走并行下载
    let remaining = if total_size > 0 { total_size - resume_from } else { 0 };
    let use_parallel = range_supported && remaining >= MIN_PARALLEL_SIZE && resume_from == 0;

    if use_parallel {
        log::info!(
            "[download] {} 流启用并行下载: id={}, size={}bytes, 分片数={}",
            stream_label, download_id, total_size,
            calculate_segments(total_size)
        );
        match download_parallel(client, app, url, credential, temp_path, download_id, stream_label, total_size).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!("[download] 并行下载失败，降级为单线程: {}", e);
                // 降级到单线程，删除可能的不完整文件
                let _ = tokio::fs::remove_file(temp_path).await;
            }
        }
    }

    // 单线程下载（含断点续传）
    download_single(client, app, download_id, url, credential, temp_path, stream_label, resume_from).await
}

/// 探测 Range 支持和文件大小
async fn probe_range_support(client: &reqwest::Client, url: &str, credential: &Credential) -> (u64, bool) {
    // 先发 HEAD 请求
    if let Ok(resp) = client
        .head(url)
        .headers(create_download_headers())
        .header("Cookie", credential.cookie_header())
        .send()
        .await
    {
        let total = resp.content_length().unwrap_or(0);
        let range = resp.headers()
            .get("accept-ranges")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.contains("bytes"))
            .unwrap_or(false);
        if total > 0 {
            return (total, range);
        }
    }

    // HEAD 失败，用 Range: bytes=0-0 探测
    if let Ok(resp) = client
        .get(url)
        .headers(create_download_headers())
        .header("Cookie", credential.cookie_header())
        .header("Range", "bytes=0-0")
        .send()
        .await
    {
        if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            if let Some(cr) = resp.headers().get("content-range").and_then(|v| v.to_str().ok()) {
                // Content-Range: bytes 0-0/12345678
                if let Some(total_str) = cr.split('/').last() {
                    if let Ok(total) = total_str.parse::<u64>() {
                        return (total, true);
                    }
                }
            }
        }
    }

    (0, false)
}

/// 计算分片数
fn calculate_segments(total_size: u64) -> usize {
    let max_segments = ((total_size + MIN_SEGMENT_SIZE - 1) / MIN_SEGMENT_SIZE) as usize;
    PARALLEL_THREADS.min(max_segments).max(1)
}

/// Feature 1: Range 分片并行下载
async fn download_parallel(
    client: &reqwest::Client,
    app: &AppHandle,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    download_id: &str,
    stream_label: &str,
    total_size: u64,
) -> Result<()> {
    let segment_count = calculate_segments(total_size);
    let segment_size = total_size / segment_count as u64;

    // 预分配文件
    {
        let file = tokio::fs::File::create(temp_path).await?;
        file.set_len(total_size).await?;
    }

    // 构建分片任务
    let tasks: Vec<_> = (0..segment_count)
        .map(|i| {
            let start = i as u64 * segment_size;
            let end = if i == segment_count - 1 {
                total_size - 1
            } else {
                start + segment_size - 1
            };
            (
                i,
                start,
                end,
            )
        })
        .collect();

    let total_for_progress = total_size;
    let downloaded_counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_report = Arc::new(std::sync::atomic::AtomicU64::new(0));

    let segment_results: Vec<u64> = futures::future::try_join_all(
        tasks.into_iter().map(|(seg_idx, start, end)| {
            let client = client.clone();
            let url = url.to_string();
            let cookie = credential.cookie_header();
            let temp_path = temp_path.to_path_buf();
            let download_id = download_id.to_string();
            let stream_label = stream_label.to_string();
            let downloaded_counter = downloaded_counter.clone();
            let last_report = last_report.clone();
            let app = app.clone();

            async move {
                download_range_segment(
                    &client,
                    &url,
                    &cookie,
                    &temp_path,
                    start,
                    end,
                    seg_idx,
                    &download_id,
                    &stream_label,
                    &downloaded_counter,
                    &last_report,
                    total_for_progress,
                    &app,
                )
                .await
            }
        }),
    )
    .await?;

    // 验证总大小
    let total_downloaded: u64 = segment_results.into_iter().sum();
    if total_downloaded < total_size.saturating_sub(1024) {
        anyhow::bail!(
            "并行下载不完整: 已下载{} / 总{}",
            total_downloaded,
            total_size
        );
    }

    log::info!(
        "[download] {} 流并行下载完成: id={}, size={}bytes",
        stream_label, download_id, total_downloaded
    );
    Ok(())
}

/// 下载单个 Range 分片并写入文件的对应偏移位置
async fn download_range_segment(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
    temp_path: &Path,
    start: u64,
    end: u64,
    seg_idx: usize,
    download_id: &str,
    stream_label: &str,
    downloaded_counter: &Arc<std::sync::atomic::AtomicU64>,
    last_report: &Arc<std::sync::atomic::AtomicU64>,
    total_size: u64,
    app: &AppHandle,
) -> Result<u64> {
    let range_header = format!("bytes={}-{}", start, end);
    log::debug!(
        "[download] {} 流分片#{}: id={}, range={}",
        stream_label, seg_idx, download_id, range_header
    );

    let response = client
        .get(url)
        .headers(create_download_headers())
        .header("Cookie", cookie)
        .header("Range", &range_header)
        .send()
        .await
        .context(format!("分片#{} 请求失败", seg_idx))?;

    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        anyhow::bail!("分片#{} 服务器不支持 Range: HTTP {}", seg_idx, response.status());
    }

    // 打开文件并 seek 到对应偏移
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(temp_path)
        .await
        .context("打开临时文件失败")?;
    file.seek(tokio::io::SeekFrom::Start(start)).await?;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    let mut segment_downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context(format!("分片#{} 读取失败", seg_idx))?;
        file.write_all(&chunk).await?;
        segment_downloaded += chunk.len() as u64;

        // 全局进度报告
        let global_downloaded = downloaded_counter.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed) + chunk.len() as u64;
        let prev = last_report.load(std::sync::atomic::Ordering::Relaxed);
        if global_downloaded - prev >= 512 * 1024 {
            let _ = last_report.compare_exchange(
                prev,
                global_downloaded,
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            );
            let percent = (global_downloaded as f64 / total_size as f64) * 100.0;
            let _ = app.emit(
                "download://progress",
                DownloadProgress {
                    id: download_id.to_string(),
                    label: stream_label.to_string(),
                    downloaded: global_downloaded,
                    total: total_size,
                    percent,
                },
            );
        }
    }

    file.flush().await?;
    log::debug!(
        "[download] {} 流分片#{} 完成: id={}, size={}bytes",
        stream_label, seg_idx, download_id, segment_downloaded
    );
    Ok(segment_downloaded)
}

/// 单线程下载（支持断点续传）
async fn download_single(
    client: &reqwest::Client,
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    stream_label: &str,
    resume_from: u64, // Feature 5: 断点续传起始位置
) -> Result<()> {
    let url_host = url.split('/').nth(2).unwrap_or("unknown");

    let mut request = client
        .get(url)
        .headers(create_download_headers())
        .header("Cookie", credential.cookie_header());

    // Feature 5: 断点续传 — 添加 Range 头
    if resume_from > 0 {
        request = request.header("Range", format!("bytes={}-", resume_from));
    }

    let response = request.send().await.context("请求视频流失败")?;

    let status = response.status();
    // 206 (Partial Content) 或 200 都可以接受
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        anyhow::bail!("视频流请求失败: HTTP {}", status);
    }

    let total_size = response.content_length().unwrap_or(0);
    log::info!(
        "[download] {} 流连接成功: id={}, HTTP {}, Content-Length={}, host={}, resume={}",
        stream_label, download_id, status, total_size, url_host, resume_from
    );

    // Feature 5: 断点续传 — append 模式打开文件
    let mut file = if resume_from > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(temp_path)
            .await
            .context("打开临时文件(续传)失败")?
    } else {
        tokio::fs::File::create(temp_path)
            .await
            .context("创建临时文件失败")?
    };

    let mut downloaded: u64 = resume_from;
    let mut last_report: u64 = resume_from;
    let report_interval: u64 = 512 * 1024;
    let effective_total = if total_size > 0 { total_size + resume_from } else { 0 };

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("读取流数据失败")?;
        file.write_all(&chunk).await.context("写入临时文件失败")?;
        downloaded += chunk.len() as u64;

        if downloaded - last_report >= report_interval
            || (effective_total > 0 && downloaded >= effective_total)
        {
            let percent = if effective_total > 0 {
                (downloaded as f64 / effective_total as f64) * 100.0
            } else {
                ((downloaded as f64 / (50.0 * 1024.0 * 1024.0)) % 1.0) * 100.0
            };

            let _ = app.emit(
                "download://progress",
                DownloadProgress {
                    id: download_id.to_string(),
                    label: stream_label.to_string(),
                    downloaded,
                    total: effective_total,
                    percent,
                },
            );

            last_report = downloaded;
        }
    }

    file.flush().await.context("刷新文件失败")?;
    log::info!(
        "[download] {} 流下载完成: id={}, size={}bytes, host={}",
        stream_label, download_id, downloaded, url_host
    );
    Ok(())
}

// ==================== ffmpeg 合并 / 转封装 ====================

/// 使用 ffmpeg 合并视频和音频流
pub async fn merge_streams(
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<()> {
    validate_temp_file(video_path, "视频").await?;
    validate_temp_file(audio_path, "音频").await?;

    let ffmpeg = resolve_ffmpeg_path();

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("创建输出目录失败")?;
    }

    let output = create_ffmpeg_command(&ffmpeg)
        .args([
            "-i", video_path.to_str().unwrap_or(""),
            "-i", audio_path.to_str().unwrap_or(""),
            "-c", "copy",
            "-strict", "unofficial",
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

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("创建输出目录失败")?;
    }

    let output = create_ffmpeg_command(&ffmpeg)
        .args([
            "-i", input_path.to_str().unwrap_or(""),
            "-c", "copy",
            "-movflags", "+faststart",
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

// ==================== 辅助函数 ====================

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

/// 创建 ffmpeg 子进程（隐藏控制台窗口）
fn create_ffmpeg_command(ffmpeg: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// 解析 ffmpeg 路径
fn resolve_ffmpeg_path() -> String {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let bundled = parent.join("ffmpeg.exe");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
            let resources = parent.join("resources").join("ffmpeg.exe");
            if resources.exists() {
                return resources.to_string_lossy().to_string();
            }
        }
    }
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
