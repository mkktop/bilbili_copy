use tauri::Emitter;
use crate::bilibili::credential::Credential;
use crate::bilibili::throttle;
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
use tokio_util::sync::CancellationToken;

const MAX_RETRIES: usize = 2;

/// 取消信号触发的标记错误前缀。execute_download 据此判断任务是被打断
/// （pause/cancel）而非真实失败，从而决定保留/清理 .tmp 与 emit 哪种状态。
pub const INTERRUPTED_ERROR: &str = "DOWNLOAD_INTERRUPTED:";

/// 检查 CancellationToken；若已取消则返回带 [INTERRUPTED_ERROR] 前缀的错误。
/// 每个下载循环检查点调用，开销仅为一次原子读。
fn check_cancel(cancel: &CancellationToken, detail: &str) -> Result<()> {
    if cancel.is_cancelled() {
        anyhow::bail!("{}{}", INTERRUPTED_ERROR, detail);
    }
    Ok(())
}

/// 判断错误是否为取消信号触发（用于区分 pause/cancel 与真实失败）
pub fn is_interrupted(err: &anyhow::Error) -> bool {
    err.to_string().starts_with(INTERRUPTED_ERROR)
}

// ==================== Feature 1: 并行下载常量 ====================
const MIN_PARALLEL_SIZE: u64 = 4 * 1024 * 1024; // 4MB 以下不分片
const MIN_SEGMENT_SIZE: u64 = 1 * 1024 * 1024; // 每片至少 1MB
/// 每片最大 16MB。分片数 = max(parallel_threads, 总大小/16MB)，
/// 让大文件切成更细的分片：暂停续传时损失最多 16MB（一个未完成分片）。
/// 并发度仍由 parallel_threads 控制（默认 4 个分片同时跑）。
const MAX_SEGMENT_SIZE: u64 = 16 * 1024 * 1024;

// ==================== Feature 2: 坏 CDN 节点缓存 ====================
const BAD_CDN_TTL: Duration = Duration::from_secs(600); // 10 分钟

static BAD_CDN_HOSTS: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 获取锁，中毒时恢复数据继续使用，避免一次 panic 永久拖垮后续调用
fn lock_bad_cdn() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    BAD_CDN_HOSTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
        let mut cache = lock_bad_cdn();
        prune_expired(&mut cache);
        cache.contains_key(&host)
    } else {
        false
    }
}

/// 将 URL 标记为坏节点
fn mark_bad_host(url: &str) {
    if let Some(host) = extract_host(url) {
        let mut cache = lock_bad_cdn();
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
    /// 最终文件字节数（统计用）
    pub size: u64,
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

/// 计算流指纹：基于稳定属性（bvid/cid/画质/编码或音频 id），用于区分不同流。
/// 不需要密码学强度，只需稳定且能区分即可。
///
/// **关键**：B 站流 URL 带签名、几小时就过期。基于 URL 的指纹在应用重启后
/// 重新请求 playurl 必然 URL 变化 → 指纹不匹配 → 从头下载，跨会话续传名存实亡。
/// 改用稳定属性：只要画质/编码没变（恢复时用 DB 里的 quality 作 qn），指纹一致即可续传。
/// `seed` 用于区分同一视频的 video/audio 两个流（传 "v"/"a" 即可）。
pub fn stream_fingerprint(bvid: &str, cid: i64, quality: i64, codec_or_audio: i64, seed: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    bvid.hash(&mut h);
    cid.hash(&mut h);
    quality.hash(&mut h);
    codec_or_audio.hash(&mut h);
    seed.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// `.meta` 文件第二行模式标记格式：
/// - `S`：强制单线程（append 模式，文件大小=真实进度）
/// - `P:<total_size>:<threads>:<segment_count>:<bitmap>`：并行续传。
///   bitmap 是 segment_count 个字符的字符串，每字符 `1`=该分片已完成 / `0`=未完成。
///   配合 set_len 预分配的稀疏文件，已完成分片的字节仍在文件中，恢复时跳过即可。
const META_MODE_SINGLE: &str = "S";

/// 解析后的并行续传信息（仅当 .meta 第二行是 P: 前缀时有效）
#[derive(Clone)]
struct ParallelResume {
    total_size: u64,
    threads: usize,
    segment_count: usize,
    /// 每个分片是否已完成（长度 = segment_count）
    done: Vec<bool>,
}

impl ParallelResume {
    fn completed_count(&self) -> usize {
        self.done.iter().filter(|&&d| d).count()
    }
}

/// 解析 .meta 第二行。返回 Some(ParallelResume) / Some(())force_single=true / 都不是则 None。
fn parse_meta_mode(mode_line: &str) -> (bool, Option<ParallelResume>) {
    let mode_line = mode_line.trim();
    if mode_line == META_MODE_SINGLE {
        return (true, None);
    }
    if let Some(rest) = mode_line.strip_prefix("P:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 4 {
            if let (Ok(total), Ok(threads), Ok(seg_count)) = (
                parts[0].parse::<u64>(),
                parts[1].parse::<usize>(),
                parts[2].parse::<usize>(),
            ) {
                let bitmap = parts[3];
                // 位图长度必须等于 segment_count，且只含 0/1
                if bitmap.len() == seg_count && bitmap.chars().all(|c| c == '0' || c == '1') {
                    let done: Vec<bool> = bitmap.chars().map(|c| c == '1').collect();
                    return (false, Some(ParallelResume {
                        total_size: total,
                        threads,
                        segment_count: seg_count,
                        done,
                    }));
                }
            }
        }
        // P: 前缀但格式损坏：当作无法续传
        log::warn!("[download] .meta 并行模式行格式损坏，忽略: {}", mode_line);
    }
    (false, None)
}

/// 写入 `.meta`（单线程模式）。
fn write_meta_single(temp_path: &Path, fingerprint: &str) {
    let content = format!("{}\n{}", fingerprint, META_MODE_SINGLE);
    let _ = std::fs::write(temp_path.with_extension("meta"), content);
}

/// 写入 `.meta`：当前分片完成位图。用于并行下载初始化（全 0）与每分片完成后更新。
fn write_meta_parallel_bitmap(temp_path: &Path, fingerprint: &str, total_size: u64, threads: usize, segment_count: usize, done: &[bool]) {
    let bitmap: String = done.iter().map(|&d| if d { '1' } else { '0' }).collect();
    let content = format!("{}\nP:{}:{}:{}:{}", fingerprint, total_size, threads, segment_count, bitmap);
    let _ = std::fs::write(temp_path.with_extension("meta"), content);
}

/// 断点续传校验结果。
struct ResumeInfo {
    /// 单线程续传：可续传的已存在字节数（0 = 从头下载）
    size: u64,
    /// 是否强制单线程下载
    force_single: bool,
    /// 并行续传：若 .meta 记录了分片完成位图且与本次参数匹配，返回之。
    /// download_parallel 据此跳过已完成分片。
    parallel: Option<ParallelResume>,
}

/// 断点续传完整性校验：
/// - 读 `.meta` 第一行比对指纹；不匹配（换流）则丢弃旧文件
/// - 第二行决定续传方式：S=单线程（size=文件大小），P:..=并行（位图记录分片完成情况）
/// - 并行续传要求文件存在（稀疏文件含已完成分片的字节）且 total_size/threads 匹配
async fn verify_resume_size(temp_path: &Path, fingerprint: &str) -> ResumeInfo {
    let existing = get_existing_size(temp_path).await;
    let meta_path = temp_path.with_extension("meta");

    let parsed = std::fs::read_to_string(&meta_path).ok();
    let (fp_matches, mode_line) = match parsed {
        Some(ref s) => {
            let mut lines = s.lines();
            let fp = lines.next().unwrap_or("").trim();
            let mode = lines.next().unwrap_or("").trim();
            (fp == fingerprint, mode)
        }
        None => (false, ""),
    };

    if !fp_matches {
        // 指纹不匹配（换流或无 .meta）：清理旧文件，从头下载
        if existing > 0 {
            log::warn!(
                "[download] 临时文件属于不同流，丢弃重下: {:?}",
                temp_path
            );
            let _ = tokio::fs::remove_file(temp_path).await;
        }
        let _ = tokio::fs::remove_file(&meta_path).await;
        return ResumeInfo { size: 0, force_single: false, parallel: None };
    }

    let (force_single, parallel) = parse_meta_mode(mode_line);

    // 并行续传：必须文件存在（稀疏文件）。若 .tmp 不存在，并行续传无意义，回退从头并行。
    let parallel = if let Some(pr) = parallel {
        if existing == 0 || pr.total_size == 0 {
            None // 文件没了，无法续传
        } else {
            Some(pr)
        }
    } else {
        None
    };

    ResumeInfo {
        size: existing,
        force_single,
        parallel,
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
/// 支持：多 URL 回退 + 重试 + 坏节点缓存 + 断点续传 + Range 分片并行 + 取消
/// `fingerprint`: 基于稳定属性的流指纹，用于跨会话续传校验
/// `cancel`: 取消信号（pause/cancel 时触发），循环内检查点据此中止
/// `parallel_threads`: Range 分片线程数（1 = 关闭并行）
pub async fn download_stream(
    app: &AppHandle,
    download_id: &str,
    urls: &[String],
    credential: &Credential,
    temp_dir: &Path,
    stream_label: &str,
    parallel_threads: usize,
    fingerprint: &str,
    max_bps: u64,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    let client = download_client()?;
    let extension = if stream_label == "video" {
        "video.tmp"
    } else {
        "audio.tmp"
    };
    let temp_path = temp_dir.join(format!("{}.{}", download_id, extension));

    let mut last_error = String::new();

    // Feature 5: 断点续传 — 校验已有文件是否属于同一流，并取续传信息。
    // .meta 第二行决定续传方式（S=单线程/P:..=并行分片位图）。
    // 若是全新下载（size=0 且无并行位图），.meta 由 download_parallel/download_single
    // 在获知 total_size 后初始化（download_stream 此处无法知道 total_size）。
    let resume = verify_resume_size(&temp_path, fingerprint).await;
    if resume.size > 0 || resume.parallel.is_some() {
        let detail = if let Some(ref pr) = resume.parallel {
            format!("（并行续传: {}/{} 分片已完成）", pr.completed_count(), pr.segment_count)
        } else if resume.force_single {
            "（单线程模式）".to_string()
        } else {
            String::new()
        };
        log::info!(
            "[download] {} 流检测到续传: id={}, 已有{}bytes{}",
            stream_label, download_id, resume.size, detail
        );
    }
    let existing_size = resume.size;
    // 上次并行标记单线程 → 本次强制单线程（append 模式可续传）
    let effective_threads = if resume.force_single { 1 } else { parallel_threads };
    let parallel_resume = resume.parallel;

    // 取消检查：进入正式下载前
    check_cancel(cancel, "download_stream 入口")?;

    // 依次尝试所有 URL（主 URL + 备用 URL）
    for (url_idx, url) in urls.iter().enumerate() {
        // Feature 2: 跳过坏节点
        if is_bad_host(url) {
            log::info!("[download] {} 流跳过坏CDN节点: id={}, host=URL#{}", stream_label, download_id, url_idx);
            continue;
        }

        for retry in 0..=MAX_RETRIES {
            // 每轮重试前检查取消信号（避免在已 cancel 后仍发起请求）
            check_cancel(cancel, "download_stream 重试循环")?;

            match download_file(
                &client,
                app,
                download_id,
                url,
                credential,
                &temp_path,
                stream_label,
                existing_size,
                effective_threads,
                fingerprint,
                max_bps,
                parallel_resume.clone(),
                cancel,
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
                        let _ = tokio::fs::remove_file(temp_path.with_extension("meta")).await;
                        break;
                    }
                    // 下载完成，清理断点续传指纹文件
                    let _ = tokio::fs::remove_file(temp_path.with_extension("meta")).await;
                    return Ok(temp_path.clone());
                }
                Err(e) => {
                    // 取消信号错误：直接向上传播，不重试、不标坏节点
                    if is_interrupted(&e) {
                        return Err(e);
                    }
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

/// 下载单个 URL 到文件（自动选择并行/单线程 + 支持断点续传 + 取消）
/// `parallel_threads`: Range 分片线程数（1 = 关闭并行）
/// `fingerprint`: 流指纹，用于初始化/更新 .meta
/// `parallel_resume`: 上次并行中断留下的分片完成位图（若与本次 total_size 匹配则续传）
async fn download_file(
    client: &reqwest::Client,
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    stream_label: &str,
    existing_size: u64,
    parallel_threads: usize,
    fingerprint: &str,
    max_bps: u64,
    parallel_resume: Option<ParallelResume>,
    cancel: &CancellationToken,
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
    let use_parallel = parallel_threads > 1 && range_supported && remaining >= MIN_PARALLEL_SIZE && resume_from == 0;

    if use_parallel {
        // 校验并行续传信息：total_size 必须匹配，否则位图无意义，丢弃重下。
        // （不同 URL 可能返回不同大小，或用户改了画质。指纹层面的流一致性已由 verify_resume_size 保证。）
        let pr = parallel_resume.and_then(|p| {
            if p.total_size == total_size {
                Some(p)
            } else {
                log::warn!(
                    "[download] {} 流并行续传 total_size 不匹配 ({} vs {})，丢弃位图重下: id={}",
                    stream_label, p.total_size, total_size, download_id
                );
                None
            }
        });

        let seg_total = calculate_segments(total_size, parallel_threads);
        if let Some(ref p) = pr {
            log::info!(
                "[download] {} 流启用并行下载(续传): id={}, size={}bytes, 分片数={}, 已完成{}/{}",
                stream_label, download_id, total_size, seg_total, p.completed_count(), p.segment_count
            );
        } else {
            log::info!(
                "[download] {} 流启用并行下载: id={}, size={}bytes, 分片数={}",
                stream_label, download_id, total_size, seg_total
            );
        }

        match download_parallel(
            client, app, url, credential, temp_path, download_id, stream_label,
            total_size, parallel_threads, fingerprint, max_bps, pr, cancel,
        ).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                // 取消信号错误：直接向上传播。.tmp（稀疏文件）与 .meta（分片位图）均保留，
                // 由 download_parallel 内部已落盘的位图保证下次能续传未完成分片。
                if is_interrupted(&e) {
                    return Err(e);
                }
                log::warn!("[download] 并行下载失败，降级为单线程: {}", e);
                // 降级到单线程，删除可能的不完整文件 + .meta
                let _ = tokio::fs::remove_file(temp_path).await;
                let _ = tokio::fs::remove_file(temp_path.with_extension("meta")).await;
            }
        }
    }

    // 单线程下载（含断点续传）。初始化 .meta 为单线程模式（若尚未写过）。
    if !temp_path.with_extension("meta").exists() {
        write_meta_single(temp_path, fingerprint);
    }
    download_single(client, app, download_id, url, credential, temp_path, stream_label, resume_from, max_bps, cancel).await
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
/// 计算分片数：取「并发线程数」与「按 16MB 上限切分」两者较大值。
/// - 至少 threads 个分片（保证并发度）
/// - 大文件额外细分，让每片不超过 16MB（暂停续传粒度更细）
fn calculate_segments(total_size: u64, threads: usize) -> usize {
    let max_segments = ((total_size + MIN_SEGMENT_SIZE - 1) / MIN_SEGMENT_SIZE) as usize;
    let by_threads = threads.max(1);
    let by_max_seg = if total_size > 0 {
        ((total_size + MAX_SEGMENT_SIZE - 1) / MAX_SEGMENT_SIZE) as usize
    } else {
        1
    };
    by_threads.max(by_max_seg).min(max_segments).max(1)
}

/// Feature 1: Range 分片并行下载（支持分片级续传）
///
/// 续传机制：`.tmp` 用 set_len 预分配稀疏文件，每个分片独立 seek 写入。
/// 每个分片下载成功后，立即把"该分片已完成"写入 `.meta`（互斥保护）。
/// 中断后 .tmp 保留（已完成分片字节仍在），.meta 保留位图；下次恢复跳过已完成分片。
///
/// `parallel_resume`: 上次中断的位图（total_size 已校验匹配）。segment_count 不匹配则忽略。
async fn download_parallel(
    client: &reqwest::Client,
    app: &AppHandle,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    download_id: &str,
    stream_label: &str,
    total_size: u64,
    threads: usize,
    fingerprint: &str,
    max_bps: u64,
    parallel_resume: Option<ParallelResume>,
    cancel: &CancellationToken,
) -> Result<()> {
    let segment_count = calculate_segments(total_size, threads);
    let segment_size = total_size / segment_count as u64;

    // 续传位图：仅当 pr 的 segment_count 与本次一致时才采纳（threads 变了分片边界不同）
    let mut done: Vec<bool> = match &parallel_resume {
        Some(p) if p.segment_count == segment_count => p.done.clone(),
        _ => vec![false; segment_count],
    };
    if parallel_resume.is_some() && parallel_resume.as_ref().unwrap().segment_count != segment_count {
        log::warn!(
            "[download] {} 流分片数变化 ({} vs {})，无法续传，重下所有分片: id={}",
            stream_label, parallel_resume.as_ref().unwrap().segment_count, segment_count, download_id
        );
    }

    // 预分配文件：仅当文件不存在或大小 != total_size 时才 set_len。
    // 续传时文件已存在（稀疏文件含已完成分片字节），重建会清空数据！
    let need_alloc = match tokio::fs::metadata(temp_path).await {
        Ok(m) => m.len() != total_size,
        Err(_) => true,
    };
    if need_alloc {
        let file = tokio::fs::File::create(temp_path).await?;
        file.set_len(total_size).await?;
        // 文件被重建 → 已完成分片字节丢失，位图全部失效
        if done.iter().any(|&d| d) {
            log::warn!(
                "[download] {} 流文件被重建，已有分片位图失效: id={}",
                stream_label, download_id
            );
            done = vec![false; segment_count];
        }
    }

    // 初始化 .meta（若 pr 位图被采纳则保留，否则全 0）
    write_meta_parallel_bitmap(temp_path, fingerprint, total_size, threads, segment_count, &done);

    // 构建分片任务：跳过已完成分片
    let tasks: Vec<_> = (0..segment_count)
        .filter_map(|i| {
            if done[i] {
                return None; // 已完成，跳过
            }
            let start = i as u64 * segment_size;
            let end = if i == segment_count - 1 {
                total_size - 1
            } else {
                start + segment_size - 1
            };
            Some((i, start, end))
        })
        .collect();

    // 进度计数器初值 = 已完成分片的总字节（让进度条从续传位置开始而非 0）
    let initial_downloaded: u64 = (0..segment_count)
        .filter(|&i| done[i])
        .map(|i| {
            let start = i as u64 * segment_size;
            if i == segment_count - 1 { total_size - start } else { segment_size }
        })
        .sum();
    let total_for_progress = total_size;
    let downloaded_counter = Arc::new(std::sync::atomic::AtomicU64::new(initial_downloaded));
    let last_report = Arc::new(std::sync::atomic::AtomicU64::new(initial_downloaded));

    // 续传时立即发一次初始进度事件，让前端进度条直接显示在续传位置（而非从 0 开始等首次 tick）
    if initial_downloaded > 0 {
        let percent = (initial_downloaded as f64 / total_size as f64) * 100.0;
        let _ = app.emit(
            "download://progress",
            DownloadProgress {
                id: download_id.to_string(),
                label: stream_label.to_string(),
                downloaded: initial_downloaded,
                total: total_size,
                percent,
            },
        );
        log::info!(
            "[download] {} 流续传初始进度已上报: id={}, {}/{}bytes ({:.1}%)",
            stream_label, download_id, initial_downloaded, total_size, percent
        );
    }

    // 位图状态 + .meta 落盘的互斥保护（多分片并发完成时串行化写入）
    let done_state = Arc::new(Mutex::new(done.clone()));
    let meta_lock = Arc::new(Mutex::new(()));
    // 本次需下载的分片数（已排除续传时已完成的分片）。
    let total_to_download = tasks.len();
    // 已完成分片计数，用于降频落盘：写 .meta 是同步 syscall，若每个分片完成都写，
    // N 个分片会触发 N 次阻塞写（克隆整个位图 + 落盘），拖慢 async worker 线程。
    // 改为每 FLUSH_EVERY 个分片落一次 + 最后一个必落，写次数从 N 降到 ~N/8。
    let completed_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    const FLUSH_EVERY: usize = 8;

    let segment_results = futures::future::try_join_all(
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
            let cancel = cancel.clone();
            let done_state = done_state.clone();
            let meta_lock = meta_lock.clone();
            let fingerprint = fingerprint.to_string();
            let completed_count = completed_count.clone();

            async move {
                let bytes = download_range_segment(
                    &client, &url, &cookie, &temp_path, start, end, seg_idx,
                    &download_id, &stream_label, &downloaded_counter, &last_report,
                    total_for_progress, &app, max_bps, &cancel,
                )
                .await?;

                // 分片完成：内存位图始终更新；.meta 降频落盘（每 FLUSH_EVERY 个 / 最后一个）。
                // meta_lock 串行化写盘，避免并发写损坏文件。
                {
                    let _g = meta_lock.lock();
                    let mut state = done_state.lock().unwrap_or_else(|p| p.into_inner());
                    if seg_idx < state.len() {
                        state[seg_idx] = true;
                    }
                    let done_now = completed_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let should_flush = done_now % FLUSH_EVERY == 0 || done_now == total_to_download;
                    if should_flush {
                        let snapshot = state.clone();
                        drop(state);
                        write_meta_parallel_bitmap(&temp_path, &fingerprint, total_size, threads, segment_count, &snapshot);
                    }
                }
                Ok::<u64, anyhow::Error>(bytes)
            }
        }),
    )
    .await;

    // try_join_all 失败/中断（某分片 Err 或 cancel）时，在途分片被取消，
    // 上面降频落盘可能没覆盖到最新进度。用最终内存位图补落一次，
    // 保证续传位图与磁盘已写分片一致。
    let segment_results: Vec<u64> = match segment_results {
        Ok(v) => v,
        Err(e) => {
            let snapshot = done_state.lock().unwrap_or_else(|p| p.into_inner()).clone();
            write_meta_parallel_bitmap(temp_path, fingerprint, total_size, threads, segment_count, &snapshot);
            return Err(e);
        }
    };

    // 验证：本次新下载的字节 + 续传已有字节 ≈ total_size
    let newly_downloaded: u64 = segment_results.into_iter().sum();
    let total_accounted = newly_downloaded + initial_downloaded;
    if total_accounted < total_size.saturating_sub(1024) {
        anyhow::bail!(
            "并行下载不完整: 本次{} + 续传{} / 总{}",
            newly_downloaded, initial_downloaded, total_size
        );
    }

    log::info!(
        "[download] {} 流并行下载完成: id={}, 本次{} + 续传{} = {}bytes (总{})",
        stream_label, download_id, newly_downloaded, initial_downloaded, total_accounted, total_size
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
    max_bps: u64,
    cancel: &CancellationToken,
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
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(temp_path)
        .await
        .context("打开临时文件失败")?;
    // BufWriter：合并网络小 chunk（默认 ~8KB）为 64KB 大块再落盘，显著减少 syscall 次数。
    // seek 在 buffer 为空时直接 forward 到底层文件，不受缓冲影响。
    let mut file = tokio::io::BufWriter::with_capacity(64 * 1024, file);
    file.seek(tokio::io::SeekFrom::Start(start)).await?;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    let mut segment_downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        // 取消检查：每读一个 chunk 检查一次（开销仅一次原子读）
        check_cancel(cancel, "download_range_segment chunk")?;
        let chunk = chunk.context(format!("分片#{} 读取失败", seg_idx))?;
        // 全局限速：写入前申请字节额度（max_bps=0 时零开销直接返回）
        throttle::global_limiter().acquire(chunk.len() as u64, max_bps).await;
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

/// 单线程下载（支持断点续传 + 取消）
async fn download_single(
    client: &reqwest::Client,
    app: &AppHandle,
    download_id: &str,
    url: &str,
    credential: &Credential,
    temp_path: &Path,
    stream_label: &str,
    resume_from: u64, // Feature 5: 断点续传起始位置
    max_bps: u64,
    cancel: &CancellationToken,
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
    let file = if resume_from > 0 {
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
    // BufWriter：合并网络小 chunk 为 64KB 大块再落盘，显著减少 syscall 次数。
    // append 模式下续传写在文件末尾，缓冲在 flush()（函数末尾）时统一落盘。
    let mut file = tokio::io::BufWriter::with_capacity(64 * 1024, file);

    let mut downloaded: u64 = resume_from;
    let mut last_report: u64 = resume_from;
    let report_interval: u64 = 512 * 1024;
    let effective_total = if total_size > 0 { total_size + resume_from } else { 0 };

    // 续传时立即发一次初始进度，让前端进度条直接显示在续传位置
    if resume_from > 0 && effective_total > 0 {
        let percent = (downloaded as f64 / effective_total as f64) * 100.0;
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
    }

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        // 取消检查：每读一个 chunk 检查一次（开销仅一次原子读）
        check_cancel(cancel, "download_single chunk")?;
        let chunk = chunk.context("读取流数据失败")?;
        // 全局限速：写入前申请字节额度（max_bps=0 时零开销直接返回）
        throttle::global_limiter().acquire(chunk.len() as u64, max_bps).await;
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

    let metadata_title = format!("BilbliCopy {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    let output = create_ffmpeg_command(&ffmpeg)
        .args([
            "-i", video_path.to_str().unwrap_or(""),
            "-i", audio_path.to_str().unwrap_or(""),
            "-c", "copy",
            "-strict", "unofficial",
            "-metadata", &format!("title={}", metadata_title),
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

    let metadata_title = format!("BilbliCopy {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    let output = create_ffmpeg_command(&ffmpeg)
        .args([
            "-i", input_path.to_str().unwrap_or(""),
            "-c", "copy",
            "-movflags", "+faststart",
            "-metadata", &format!("title={}", metadata_title),
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

/// 仅音频下载：用 ffmpeg 将 B站 DASH 音频流（m4s/fMP4）封装为 .m4a 或转码为 .mp3。
///
/// @param format "m4a" = 无损封装（-c copy，保留原始 AAC）；"mp3" = 转码（libmp3lame VBR ~190kbps）
pub async fn remux_audio(
    input_path: &Path,
    output_path: &Path,
    format: &str,
) -> Result<()> {
    validate_temp_file(input_path, "音频").await?;

    let ffmpeg = resolve_ffmpeg_path();

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("创建输出目录失败")?;
    }

    let metadata_title = format!("BilbliCopy {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));

    let output = if format == "mp3" {
        // MP3 转码：AAC → MP3（有损，VBR ~190kbps，兼容老旧设备）
        create_ffmpeg_command(&ffmpeg)
            .args([
                "-i", input_path.to_str().unwrap_or(""),
                "-vn",                          // 丢弃可能存在的视频轨（防御）
                "-c:a", "libmp3lame",
                "-q:a", "2",                    // VBR 质量（2 ≈ 190kbps）
                "-metadata", &format!("title={}", metadata_title),
                "-y",
                output_path.to_str().unwrap_or(""),
            ])
            .output()
            .await
    } else {
        // M4A 无损封装：fMP4 音频段直接封装为 .m4a（-c copy，零转码）
        create_ffmpeg_command(&ffmpeg)
            .args([
                "-i", input_path.to_str().unwrap_or(""),
                "-vn",
                "-c", "copy",
                "-metadata", &format!("title={}", metadata_title),
                "-y",
                output_path.to_str().unwrap_or(""),
            ])
            .output()
            .await
    }
    .context(format!("执行ffmpeg音频封装失败，内置ffmpeg可能缺失。当前路径: {}", ffmpeg))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg音频封装失败: {}", stderr);
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
        // 同步清理断点续传指纹文件
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculate_segments_caps_segment_at_16mb() {
        // 每片最大 16MB：大文件细分，保证暂停续传损失 ≤ 16MB。
        // 并发度由 threads（默认 4）控制，分片数 ≥ threads。
        let m = 1024 * 1024u64;

        // 5MB：threads=4，按 16MB 切只能切 1 片 → 取 max(4,1)=4 片，每片 ~1.25MB
        assert_eq!(calculate_segments(5 * m, 4), 4);

        // 50MB：按 16MB 切 → 4 片（50/16≈3.1→4），与 threads=4 一致
        assert_eq!(calculate_segments(50 * m, 4), 4);

        // 100MB：按 16MB 切 → 7 片（100/16≈6.25→7），> threads=4 → 取 7 片，每片 ~14MB
        assert_eq!(calculate_segments(100 * m, 4), 7);
        assert!(100 * m / 7 <= 16 * m, "每片应 ≤ 16MB");

        // 385MB：按 16MB 切 → 25 片（385/16≈24.06→25），每片 ~15MB
        assert_eq!(calculate_segments(385 * m, 4), 25);

        // 1GB：按 16MB 切 → 64 片
        assert_eq!(calculate_segments(1024 * m, 4), 64);

        // threads=8 时：分片数至少 8（保证并发度），大文件按 16MB 上限再加
        assert_eq!(calculate_segments(20 * m, 8), 8, "小文件至少 threads 片");
        assert_eq!(calculate_segments(200 * m, 8), 13, "200MB/16MB≈12.5→13，> 8");

        // 极小文件：至少 1 片
        assert_eq!(calculate_segments(1, 4), 1);
        assert_eq!(calculate_segments(0, 4), 1, "0 字节也要返回 1，避免除零");
    }

    #[test]
    fn fingerprint_is_stable_and_distinct() {
        // 基于稳定属性（bvid/cid/quality/codec/seed）的指纹：
        // 相同属性 → 相同指纹；任一属性变化 → 不同指纹。
        assert_eq!(
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            "相同流属性指纹必须稳定"
        );
        assert_ne!(
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            stream_fingerprint("BV1xx", 100, 80, 7, "a"),
            "video/audio 流（seed 不同）指纹必须不同"
        );
        assert_ne!(
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            stream_fingerprint("BV1xx", 100, 80, 12, "v"),
            "不同 codec 指纹必须不同"
        );
        assert_ne!(
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            stream_fingerprint("BV1xx", 100, 64, 7, "v"),
            "不同画质指纹必须不同"
        );
        assert_ne!(
            stream_fingerprint("BV1xx", 100, 80, 7, "v"),
            stream_fingerprint("BV1xx", 101, 80, 7, "v"),
            "不同 cid 指纹必须不同"
        );
    }

    #[test]
    fn sanitize_filename_blocks_path_traversal() {
        assert_eq!(sanitize_filename("a/b"), "a_b", "正斜杠必须替换");
        assert_eq!(sanitize_filename("..\\evil"), ".._evil", "反斜杠必须替换（前导点保留，无分隔符即安全）");
        assert_eq!(sanitize_filename("CON"), "CON_video", "Windows 保留名需加后缀");
        // 关键：绝不能残留路径分隔符，否则可写到目录之外
        let cleaned = sanitize_filename("../../etc/passwd");
        assert!(!cleaned.contains('/'), "清洗后不得残留 '/'");
        assert!(!cleaned.contains('\\'), "清洗后不得残留 '\\'");
    }

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bcopy_test_{}_{}.tmp",
            tag,
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn resume_single_thread_mode() {
        // 单线程模式：.meta 第二行 = S，size = 文件大小
        let path = temp_path("single_mode");
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;

        let fp = stream_fingerprint("BV1xx", 100, 80, 7, "v");
        tokio::fs::write(&path, b"hello12345").await.unwrap();
        write_meta_single(&path, &fp);

        let info = verify_resume_size(&path, &fp).await;
        assert_eq!(info.size, 10, "单线程模式应返回已有字节数供续传");
        assert!(info.force_single, "S 模式应强制单线程");
        assert!(info.parallel.is_none(), "单线程模式无并行续传信息");

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }

    /// 关键回归：换了流（不同 URL/画质/编码）时，应丢弃旧文件从头下载。
    #[tokio::test]
    async fn resume_discards_when_fingerprint_differs() {
        let path = temp_path("diff");
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;

        let old_fp = stream_fingerprint("BV1xx", 100, 80, 7, "v");
        let new_fp = stream_fingerprint("BV1xx", 100, 64, 7, "v");

        tokio::fs::write(&path, b"stale-bytes-of-old-stream").await.unwrap();
        write_meta_single(&path, &old_fp);

        let info = verify_resume_size(&path, &new_fp).await;
        assert_eq!(info.size, 0, "换流时应返回 0（从头下载）");
        assert!(!info.force_single);
        let still_exists = tokio::fs::metadata(&path).await.is_ok();
        assert!(!still_exists, "换流时应删除旧临时文件，避免拼接损坏");

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }

    /// 并行续传：.meta 第二行 = P:total:threads:n:bitmap，.tmp 存在（稀疏文件含已完成分片）。
    /// verify_resume_size 应返回 parallel=Some(位图)，让 download_parallel 跳过已完成分片。
    #[tokio::test]
    async fn resume_parallel_bitmap() {
        let path = temp_path("pbitmap");
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;

        let fp = stream_fingerprint("BV1xx", 100, 80, 7, "v");
        // 模拟中断后状态：4 个分片，第 0、2 个已完成
        let done = vec![true, false, true, false];
        // .tmp 存在（稀疏文件，大小=total_size）
        tokio::fs::write(&path, vec![0u8; 1000]).await.unwrap();
        write_meta_parallel_bitmap(&path, &fp, 1000, 4, 4, &done);

        let info = verify_resume_size(&path, &fp).await;
        assert_eq!(info.size, 1000, "稀疏文件大小 = total_size");
        assert!(!info.force_single);
        let pr = info.parallel.expect("应解析出并行续传位图");
        assert_eq!(pr.total_size, 1000);
        assert_eq!(pr.threads, 4);
        assert_eq!(pr.segment_count, 4);
        assert_eq!(pr.done, vec![true, false, true, false]);
        assert_eq!(pr.completed_count(), 2);

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }

    /// 并行续传但 .tmp 被删（existing=0）：位图无意义，应回退 None（从头并行）
    #[tokio::test]
    async fn resume_parallel_bitmap_ignored_when_tmp_missing() {
        let path = temp_path("pnomtmp");
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;

        let fp = stream_fingerprint("BV1xx", 100, 80, 7, "v");
        let done = vec![true, false, true, false];
        // 不写 .tmp（文件不存在）
        write_meta_parallel_bitmap(&path, &fp, 1000, 4, 4, &done);

        let info = verify_resume_size(&path, &fp).await;
        assert_eq!(info.size, 0, ".tmp 不存在 → size=0");
        assert!(info.parallel.is_none(), "文件没了，并行位图无意义，应回退 None");

        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }

    /// .meta 格式损坏（P: 前缀但字段不对）应安全回退，不 panic
    #[tokio::test]
    async fn resume_handles_corrupt_meta() {
        let path = temp_path("corrupt");
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;

        let fp = stream_fingerprint("BV1xx", 100, 80, 7, "v");
        tokio::fs::write(&path, b"data").await.unwrap();
        // 损坏的 P: 行（字段数不对）
        let content = format!("{}\nP:abc", fp);
        std::fs::write(path.with_extension("meta"), content).unwrap();

        let info = verify_resume_size(&path, &fp).await;
        // 指纹匹配，但模式行损坏 → 不强制单线程、无并行位图
        assert!(!info.force_single);
        assert!(info.parallel.is_none());

        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("meta")).await;
    }

    /// parse_meta_mode 的纯逻辑测试
    #[test]
    fn parse_meta_mode_logic() {
        let (fs, pr) = parse_meta_mode("S");
        assert!(fs && pr.is_none());

        let (fs, pr) = parse_meta_mode("P:1000:4:4:1010");
        assert!(!fs);
        let pr = pr.unwrap();
        assert_eq!(pr.total_size, 1000);
        assert_eq!(pr.done, vec![true, false, true, false]);

        // 空行 / 未知格式 → 都不是
        let (fs, pr) = parse_meta_mode("");
        assert!(!fs && pr.is_none());

        // 位图长度与 segment_count 不符 → 视为损坏
        let (fs, pr) = parse_meta_mode("P:1000:4:4:101");
        assert!(!fs && pr.is_none());

        // 非 0/1 字符 → 损坏
        let (fs, pr) = parse_meta_mode("P:1000:4:4:10x0");
        assert!(!fs && pr.is_none());
    }
}
