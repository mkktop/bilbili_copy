use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::bilibili::credential::Credential;
use crate::bilibili::download::{
    cleanup_temp_files, download_stream, is_interrupted, merge_streams, remux_to_mp4,
    sanitize_filename, stream_fingerprint,
};
use crate::bilibili::playurl::get_playurl;
use crate::bilibili::url;
use crate::commands::settings::{get_settings, AppSettings};
use crate::download_manager::{manager, DownloadParams};
use tauri::AppHandle;

/// 校验 download_id，防止路径穿越
fn sanitize_download_id(id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Err("下载ID不能为空".to_string());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("下载ID包含非法字符".to_string());
    }
    Ok(id.to_string())
}

/// 检查错误信息是否为登录过期
fn is_login_expired(error_msg: &str) -> bool {
    error_msg.contains("-101") || error_msg.contains("账号未登录") || error_msg.contains("登录过期")
}

/// 检查错误信息是否为风控，返回 v_voucher
fn extract_risk_control(error_msg: &str) -> Option<String> {
    error_msg
        .strip_prefix("RISK_CONTROL:")
        .map(|s| s.to_string())
}

// ==================== 动态并发控制（从 settings 读取） ====================

/// 获取锁，中毒（持锁期间 panic）时也恢复数据继续使用，
/// 避免一次 panic 永久拖垮后续所有依赖该锁的调用。
fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 全局下载并发限流器：持有当前已配置的容量与对应信号量。
/// 仅在配置容量变化时才重建信号量——重建时机错误（如过去用 available_permits 判断）
/// 会导致只要有下载在跑就误重建出满额信号量，使并发限制完全失效。参见 tests。
struct GlobalLimiter {
    capacity: usize,
    sem: Arc<Semaphore>,
}

impl GlobalLimiter {
    fn new(capacity: usize) -> Self {
        let cap = clamp_permits(capacity);
        Self {
            capacity: cap,
            sem: Arc::new(Semaphore::new(cap)),
        }
    }

    /// 返回与 `want` 容量匹配的信号量：容量不变时复用（permits 计数共享），
    /// 容量变化时重建。`want` 会被 clamp 到 >=1。
    fn ensure(&mut self, want: usize) -> Arc<Semaphore> {
        let want = clamp_permits(want);
        if self.capacity != want {
            self.capacity = want;
            self.sem = Arc::new(Semaphore::new(want));
        }
        self.sem.clone()
    }
}

static DOWNLOAD_SEMAPHORE: Lazy<Mutex<GlobalLimiter>> =
    Lazy::new(|| Mutex::new(GlobalLimiter::new(1)));

static VIDEO_SEMAPHORES: Lazy<Mutex<HashMap<String, Arc<Semaphore>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 将并发上限 clamp 到 >=1，避免 Semaphore::new(0) 创建零许可信号量导致 acquire() 永久阻塞
fn clamp_permits(n: usize) -> usize {
    if n == 0 { 1 } else { n }
}

/// 确保全局 Semaphore 的 permits 数与设置一致（仅在配置变化时重建）。
/// 由 dispatcher（download_manager）在取出任务后调用获取 permit。
pub fn ensure_global_semaphore(settings: &AppSettings) -> Arc<Semaphore> {
    let mut guard = lock_or_recover(&DOWNLOAD_SEMAPHORE);
    guard.ensure(settings.max_concurrent_downloads)
}

fn get_video_semaphore(bvid: &str, max_pages: usize) -> Arc<Semaphore> {
    let want = clamp_permits(max_pages);
    let mut map = lock_or_recover(&VIDEO_SEMAPHORES);
    map.entry(bvid.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(want)))
        .clone()
}

fn cleanup_video_semaphore(bvid: &str, max_pages: usize) {
    let want = clamp_permits(max_pages);
    let mut map = lock_or_recover(&VIDEO_SEMAPHORES);
    if let Some(sem) = map.get(bvid) {
        if sem.available_permits() == want {
            map.remove(bvid);
        }
    }
}

// ==================== execute_download 执行结果 ====================

/// execute_download 的执行结果。dispatcher 据此（结合 target 状态）emit 对应事件。
pub enum ExecOutcome {
    /// 正常下载完成，附带输出路径
    Done(String),
    /// 真实失败（网络/解析/ffmpeg 等非中断错误）
    Failed(String),
    /// 被 cancel 信号中断（pause/cancel）
    Interrupted,
}

/// 提交下载任务（命令入口）。
///
/// 与旧实现不同：本命令**只做前置校验并把任务提交到调度器**，立即返回 Ok。
/// 真正的下载由 dispatcher 在拿到并发 permit 后异步执行，前端通过事件感知：
/// - `download://state`(downloading) — 开始执行
/// - `download://progress`           — 进度
/// - `download://complete`           — 完成
/// - `download://error`              — 失败（含风控）
/// 命令返回的 Err 仅代表提交阶段失败（如未登录、参数非法），下载中途错误走事件。
#[tauri::command]
pub async fn download_video(
    id: String,
    bvid: String,
    cid: i64,
    title: String,
    video_title: String,
    qn: Option<i64>,
    ep_id: Option<u64>,
    duration: Option<u64>,
) -> Result<(), String> {
    let download_id = sanitize_download_id(&id)?;

    // 前置校验：登录态（避免无凭证任务进队列后才失败，浪费排队）
    // 这里只验证凭证文件存在且可加载，不持有——execute_download 内会重新加载（凭证可能过期需刷新）
    let cred_check = Credential::load().map_err(|e| e.to_string())?;
    if cred_check.is_none() {
        return Err("请先登录".to_string());
    }

    // 前置校验：settings 可读（dispatcher 会重新读，但这里早失败更友好）
    let _ = get_settings().map_err(|e| e.to_string())?;

    let params = DownloadParams {
        id: download_id.clone(),
        bvid,
        cid,
        title,
        video_title,
        qn,
        ep_id,
        duration,
    };

    match manager().submit(params, 0) {
        crate::download_manager::SubmitOutcome::Queued => {
            log::info!("[download] 任务已提交到调度器: id={}", download_id);
            Ok(())
        }
        crate::download_manager::SubmitOutcome::Failed(msg) => Err(msg),
    }
}

/// 暂停下载任务（中断运行中任务并保留 .tmp，或移除排队中任务）。
#[tauri::command]
pub fn pause_download(id: String) -> Result<bool, String> {
    Ok(manager().pause(&id))
}

/// 取消下载任务（中断运行中任务并清理 .tmp，或移除排队中任务）。
#[tauri::command]
pub fn cancel_download(id: String) -> Result<bool, String> {
    Ok(manager().cancel(&id))
}

/// 调整排队中任务的优先级（数值越大越优先）。运行中任务无法调整。
#[tauri::command]
pub fn set_download_priority(id: String, priority: i32) -> Result<bool, String> {
    Ok(manager().set_priority(&id, priority))
}

// ==================== 实际下载执行（dispatcher spawn 调用） ====================

/// 执行一个下载任务（由 dispatcher 在 acquire permit 后 spawn 调用）。
/// 这是旧 download_video 命令的核心逻辑，剥离了全局 Semaphore 获取（dispatcher 负责），
/// 新增 cancel 检查贯穿，返回 ExecOutcome 让 dispatcher 决定 emit。
pub async fn execute_download(
    app: &AppHandle,
    params: DownloadParams,
    cancel: &CancellationToken,
) -> ExecOutcome {
    let DownloadParams {
        id,
        bvid,
        cid,
        title,
        video_title,
        qn,
        ep_id,
        duration,
    } = params;
    let download_id = match sanitize_download_id(&id) {
        Ok(s) => s,
        Err(e) => return ExecOutcome::Failed(e),
    };

    // 重新读取 settings（dispatcher 提交后到这里可能已过一段时间，用户可能改了设置）
    let settings = match get_settings() {
        Ok(s) => s,
        Err(e) => return ExecOutcome::Failed(e.to_string()),
    };
    let max_pages = settings.max_pages_per_video;

    // 获取 per-video 分P permit（避免同一视频分P过多并发触发风控）
    let video_sem = get_video_semaphore(&bvid, max_pages);
    let _video_permit = match video_sem.acquire().await {
        Ok(p) => p,
        Err(e) => return ExecOutcome::Failed(format!("获取分P下载许可失败: {}", e)),
    };

    log::info!(
        "[download] 获得分P许可: id={}, 视频{}可用={}",
        download_id, bvid, video_sem.available_permits()
    );

    // 1. 加载凭证（必须已登录）
    let mut credential = match Credential::load() {
        Ok(Some(c)) => c,
        _ => return ExecOutcome::Failed("请先登录".to_string()),
    };

    // 2. 画质参数
    let video_max_qn = qn.unwrap_or(settings.video_max_quality);
    let video_min_qn = settings.video_min_quality;
    let audio_max_qn = settings.audio_max_quality;
    let audio_min_qn = settings.audio_min_quality;
    let codec_priority = settings.video_codec_priority.clone();

    // 3. 确定下载目录
    let download_dir = if settings.default_download_dir.is_empty() {
        let exe_dir = match std::env::current_exe() {
            Ok(p) => match p.parent() {
                Some(p) => p.join("downloads"),
                None => return ExecOutcome::Failed("无法确定下载目录".to_string()),
            },
            Err(e) => return ExecOutcome::Failed(format!("获取exe路径失败: {}", e)),
        };
        if let Err(e) = std::fs::create_dir_all(&exe_dir) {
            return ExecOutcome::Failed(format!("创建下载目录失败: {}", e));
        }
        exe_dir
    } else {
        let dir = std::path::PathBuf::from(&settings.default_download_dir);
        if !dir.exists() {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return ExecOutcome::Failed(format!("创建下载目录失败: {}", e));
            }
        }
        dir
    };

    // 4. 构建输出文件路径（每个视频独立文件夹）
    let folder_name = if video_title.is_empty() { &title } else { &video_title };
    let video_folder = download_dir.join(sanitize_filename(folder_name));
    if let Err(e) = std::fs::create_dir_all(&video_folder) {
        return ExecOutcome::Failed(format!("创建视频目录失败: {}", e));
    }
    let filename = format!("{}.mp4", sanitize_filename(&title));
    let output_path = video_folder.join(&filename);

    // 防风控指纹参数
    let dm_img_str = settings.dm_img_str.clone();
    let dm_cover_img_str = settings.dm_cover_img_str.clone();
    let dm_img_list = settings.dm_img_list.clone();
    let dm_img_inter = settings.dm_img_inter.clone();
    let request_delay_ms = settings.request_delay_ms;

    // 执行下载流程（带 cancel 信号）
    let result = run_download(
        app, &download_id, &bvid, cid,
        video_max_qn, video_min_qn, audio_max_qn, audio_min_qn,
        &codec_priority, &credential, &download_dir, &output_path,
        settings.parallel_threads, ep_id,
        &dm_img_str, &dm_cover_img_str, &dm_img_list, &dm_img_inter,
        request_delay_ms, cancel,
    ).await;

    cleanup_video_semaphore(&bvid, max_pages);

    // 取消信号中断：立即返回 Interrupted（run_download 内部已处理 .tmp 保留）
    if let Err(ref e) = result {
        if is_interrupted(e) {
            return ExecOutcome::Interrupted;
        }
    }

    // 如果下载因 -101 失败，尝试刷新 Cookie 后重试一次
    let result = match result {
        Err(ref e) if is_login_expired(&e.to_string()) => {
            log::info!("[download] 下载遇到登录过期，尝试刷新 Cookie");
            if let Ok(Some(new_cred)) = credential.check_and_refresh().await {
                credential = new_cred;
                log::info!("[download] Cookie 刷新成功，重试下载");
                run_download(
                    app, &download_id, &bvid, cid,
                    video_max_qn, video_min_qn, audio_max_qn, audio_min_qn,
                    &codec_priority, &credential, &download_dir, &output_path,
                    settings.parallel_threads, ep_id,
                    &dm_img_str, &dm_cover_img_str, &dm_img_list, &dm_img_inter,
                    request_delay_ms, cancel,
                ).await
            } else {
                result
            }
        }
        _ => result,
    };

    // 重试后再次检查中断
    if let Err(ref e) = result {
        if is_interrupted(e) {
            return ExecOutcome::Interrupted;
        }
    }

    // 检测风控错误，通知前端弹出验证码
    if let Err(ref e) = result {
        if let Some(v_voucher) = extract_risk_control(&e.to_string()) {
            log::warn!("[download] 触发风控，通知前端验证: id={}", download_id);
            let _ = app.emit(
                "download://risk_control",
                serde_json::json!({ "v_voucher": v_voucher }),
            );
        }
    }

    match result {
        Ok(()) => {
            log::info!(
                "[download] 下载完成: id={}, path={}",
                download_id,
                output_path.display()
            );

            // 附加下载：弹幕和字幕（非致命）
            if settings.download_danmaku || settings.download_subtitle {
                let aid = url::bvid_to_aid(&bvid);
                let dur = duration.unwrap_or(0);
                download_extras(
                    app,
                    &download_id,
                    &bvid,
                    cid,
                    aid,
                    dur,
                    &credential,
                    &output_path,
                    settings.download_danmaku,
                    settings.download_subtitle,
                    &title,
                )
                .await;
            }

            ExecOutcome::Done(output_path.to_string_lossy().to_string())
        }
        Err(e) => {
            let error_msg = e.to_string();
            log::error!(
                "[download] 下载失败: id={}, error={}",
                download_id,
                error_msg
            );
            ExecOutcome::Failed(error_msg)
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
    parallel_threads: usize,
    ep_id: Option<u64>,
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
    request_delay_ms: u64,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    // 5. 获取视频流地址
    log::info!(
        "[download] 开始获取流地址: id={}, bvid={}, cid={}",
        download_id, bvid, cid
    );
    let streams = get_playurl(
        bvid, cid, credential, video_max_qn, video_min_qn,
        audio_max_qn, audio_min_qn, codec_priority, ep_id,
        dm_img_str, dm_cover_img_str, dm_img_list, dm_img_inter, request_delay_ms,
    ).await?;
    log::info!(
        "[download] 流地址获取成功: id={}, legacy={}, has_audio={}, video_urls={}, audio_urls={}",
        download_id, streams.is_legacy_format, streams.has_audio(),
        streams.video_urls.len(), streams.audio_urls.len()
    );

    // 计算流指纹（基于稳定属性，跨会话续传关键）。
    // video 流用 video_qn + video_codecid；audio 流用 video_qn(作额外种子) + audio_id。
    let video_fp = stream_fingerprint(bvid, cid, streams.video_qn, streams.video_codecid, "v");
    let audio_fp = stream_fingerprint(bvid, cid, streams.video_qn, streams.audio_id, "a");

    let mut temp_files: Vec<std::path::PathBuf> = Vec::new();
    let mut interrupted = false;

    // 用闭包封装实际逻辑；取消中断时不清理 .tmp（保留续传），其它失败清理。
    let result = async {
        if streams.is_legacy_format {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, cancel,
            ).await?;
            temp_files.push(video_temp.clone());
            remux_to_mp4(&video_temp, output_path).await?;
        } else if streams.has_audio() {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, cancel,
            ).await?;
            temp_files.push(video_temp.clone());
            // 流切换前检查取消
            if cancel.is_cancelled() {
                anyhow::bail!("DOWNLOAD_INTERRUPTED:audio流切换前");
            }
            let audio_temp = download_stream(
                app, download_id, &streams.audio_urls, credential, temp_dir,
                "audio", parallel_threads, &audio_fp, cancel,
            ).await?;
            temp_files.push(audio_temp.clone());
            merge_streams(&video_temp, &audio_temp, output_path).await?;
        } else {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, cancel,
            ).await?;
            temp_files.push(video_temp.clone());
            tokio::fs::rename(&video_temp, output_path).await?;
            temp_files.pop(); // 文件已重命名，不需要清理
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    // 判断是否为取消中断
    if let Err(ref e) = result {
        interrupted = is_interrupted(e);
    }

    // 清理策略：
    // - 取消中断：保留 .tmp 供恢复续传（不调用 cleanup_temp_files）
    // - 正常完成/失败：清理 .tmp
    if !interrupted {
        cleanup_temp_files(&temp_files).await;
    } else {
        log::info!(
            "[download] 任务被中断，保留临时文件供续传: id={}, files={}",
            download_id,
            temp_files.len()
        );
    }

    result
}

/// 附加下载：弹幕（XML）和字幕（SRT），非致命
async fn download_extras(
    app: &AppHandle,
    download_id: &str,
    bvid: &str,
    cid: i64,
    aid: u64,
    duration_secs: u64,
    credential: &Credential,
    output_path: &std::path::Path,
    want_danmaku: bool,
    want_subtitle: bool,
    title: &str,
) {
    let client = match reqwest::Client::builder()
        .user_agent(crate::bilibili::USER_AGENT)
        .cookie_store(false)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[download] 创建附加下载客户端失败: {}", e);
            return;
        }
    };

    let base_path = output_path.with_extension("");

    // 弹幕下载（ASS 格式）
    if want_danmaku {
        match crate::bilibili::danmaku::fetch_danmaku_ass(
            &client, credential, cid, aid, duration_secs, title,
        )
        .await
        {
            Ok(ass_content) => {
                let dm_path = output_path.with_extension("ass");
                match tokio::fs::write(&dm_path, &ass_content).await {
                    Ok(()) => log::info!("[download] 弹幕保存成功: {}", dm_path.display()),
                    Err(e) => log::warn!("[download] 弹幕写入失败: {}", e),
                }
            }
            Err(e) => {
                log::warn!(
                    "[download] 弹幕下载失败(id={}): {}",
                    download_id,
                    e
                );
            }
        }
    }

    // 字幕下载
    if want_subtitle {
        match crate::bilibili::subtitle::get_subtitle_urls(
            &client, credential, cid, bvid, aid,
        )
        .await
        {
            Ok(subtitles) => {
                if subtitles.is_empty() {
                    log::info!("[download] 该视频无可用字幕(id={})", download_id);
                }
                for sub in &subtitles {
                    match crate::bilibili::subtitle::fetch_subtitle_srt(
                        &client,
                        &sub.subtitle_url,
                    )
                    .await
                    {
                        Ok(srt_content) => {
                            // 清洗语言代码，防止路径穿越（sub.lan 来自 API，可能含非法字符）
                            let safe_lan = sanitize_filename(&sub.lan);
                            let srt_path = format!("{}.{}.srt", base_path.display(), safe_lan);
                            match tokio::fs::write(&srt_path, &srt_content).await {
                                Ok(()) => {
                                    log::info!(
                                        "[download] 字幕保存成功({}): {}",
                                        sub.lan,
                                        srt_path
                                    )
                                }
                                Err(e) => {
                                    log::warn!("[download] 字幕写入失败({}): {}", sub.lan, e)
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("[download] 字幕下载失败({}): {}", sub.lan, e)
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[download] 获取字幕列表失败(id={}): {}",
                    download_id,
                    e
                );
            }
        }
    }

    let _ = app; // 保留 app 参数供将来扩展（如进度事件）
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_permits_never_returns_zero() {
        assert_eq!(clamp_permits(0), 1, "0 必须 clamp 到 1，否则 acquire 永久阻塞");
        assert_eq!(clamp_permits(1), 1);
        assert_eq!(clamp_permits(5), 5);
    }

    #[test]
    fn lock_or_recover_survives_poison() {
        let m = Mutex::new(42i32);
        // 模拟持锁期间 panic 导致 Mutex 中毒
        let blew_up = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("故意中毒");
        }));
        assert!(blew_up.is_err(), "应当捕获到 panic");
        // lock_or_recover 必须能恢复，否则中毒后所有依赖该锁的调用都会连锁 panic
        let g = lock_or_recover(&m);
        assert_eq!(*g, 42, "中毒后应仍能取出内部数据");
    }

    /// 关键回归：相同容量下必须复用同一信号量、permits 计数共享。
    /// 旧实现用 available_permits() 判断是否重建，只要有下载在跑就误建满额信号量 → 限制失效。
    #[test]
    fn limiter_shares_permits_within_same_capacity() {
        let mut limiter = GlobalLimiter::new(2);
        let s1 = limiter.ensure(2);
        // 占用 1 个许可（模拟一个下载在跑）
        let _held = s1
            .try_acquire()
            .expect("空限流器应能获取到许可");

        let s2 = limiter.ensure(2); // 容量未变 → 必须复用同一信号量
        assert!(
            Arc::ptr_eq(&s1, &s2),
            "容量未变时应复用同一信号量（而非重建）"
        );
        assert_eq!(
            s2.available_permits(),
            1,
            "占用 1 个许可后应剩 1 个；旧实现会返回 2 → 并发限制失效"
        );
    }

    #[test]
    fn limiter_rebuilds_when_capacity_changes() {
        let mut limiter = GlobalLimiter::new(2);
        let s1 = limiter.ensure(2);
        let s2 = limiter.ensure(4); // 容量变化 → 重建
        assert!(!Arc::ptr_eq(&s1, &s2), "容量变化应重建信号量");
        assert_eq!(s2.available_permits(), 4);
    }

    #[test]
    fn limiter_clamps_zero_capacity_so_it_never_deadlocks() {
        let mut limiter = GlobalLimiter::new(1);
        let s = limiter.ensure(0); // 0 必须 clamp 到 1
        assert_eq!(s.available_permits(), 1);
        assert!(s.try_acquire().is_ok(), "clamp 后至少应有 1 个可获取许可");
    }
}
