use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::bilibili::credential::Credential;
use crate::bilibili::download::{
    cleanup_temp_files, download_stream, is_interrupted, merge_streams, remux_audio, remux_to_mp4,
    sanitize_filename, stream_fingerprint,
};
use crate::bilibili::playurl::get_playurl;
use crate::bilibili::url;
use crate::commands::settings::{get_settings, AppSettings};
use crate::download_manager::{manager, DownloadParams, VideoMeta};
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
/// 信号量实例终生不变（同一 Arc），容量变化通过 add_permits / 扣留许可原地调整：
/// - 增大容量：先归还扣留的许可，不够再 add_permits；
/// - 缩小容量：把差额许可「扣留」起来（永久持有 = 有效容量降低）。
///   这样重建不存在，也就不会出现「旧任务持着旧信号量的 permit、新信号量又满额」
///   的瞬时超限（1→3 时 1 旧 + 3 新 = 4 并发）。
struct GlobalLimiter {
    capacity: usize,
    /// 信号量中累计创建过的许可总数（初始容量 + add_permits 之和）
    total: usize,
    sem: Arc<Semaphore>,
    /// 缩容时扣留的许可。持有不还即降低有效容量；增容时优先归还它们。
    reserved: Vec<tokio::sync::OwnedSemaphorePermit>,
}

impl GlobalLimiter {
    fn new(capacity: usize) -> Self {
        let cap = clamp_permits(capacity);
        Self {
            capacity: cap,
            total: cap,
            sem: Arc::new(Semaphore::new(cap)),
            reserved: Vec::new(),
        }
    }

    /// 返回与 `want` 容量匹配的信号量（始终是同一个实例），容量原地调整。
    /// `want` 会被 clamp 到 >=1。
    fn ensure(&mut self, want: usize) -> Arc<Semaphore> {
        let want = clamp_permits(want);
        if self.capacity == want {
            return self.sem.clone();
        }
        let effective = self.total - self.reserved.len();
        if want > effective {
            // 增容：先归还扣留的许可，不够再新建
            let mut release = want - effective;
            while release > 0 {
                match self.reserved.pop() {
                    Some(_permit) => release -= 1, // drop 即归还 1 个许可
                    None => {
                        self.sem.add_permits(release);
                        self.total += release;
                        release = 0;
                    }
                }
            }
        } else if want < effective {
            // 缩容：扣留差额许可。运行中任务占用的许可此刻拿不到，
            // 立即扣留能拿到的部分，剩余由后台任务等运行中任务释放后补扣
            // （补扣完成前并发会短暂高于新上限，随任务自然结束收敛，不会死锁）。
            let need = (effective - want) as u32;
            let mut got = 0u32;
            if let Ok(p) = Arc::clone(&self.sem).try_acquire_many_owned(need) {
                self.reserved.push(p);
                got = need;
            } else {
                while got < need {
                    match Arc::clone(&self.sem).try_acquire_many_owned(1) {
                        Ok(p) => {
                            self.reserved.push(p);
                            got += 1;
                        }
                        Err(_) => break,
                    }
                }
            }
            if got < need {
                let missing = need - got;
                let sem = Arc::clone(&self.sem);
                tauri::async_runtime::spawn(async move {
                    if let Ok(p) = sem.acquire_many_owned(missing).await {
                        let mut guard = lock_or_recover(&DOWNLOAD_SEMAPHORE);
                        guard.reserved.push(p);
                    }
                });
            }
        }
        self.capacity = want;
        self.sem.clone()
    }
}

static DOWNLOAD_SEMAPHORE: Lazy<Mutex<GlobalLimiter>> =
    Lazy::new(|| Mutex::new(GlobalLimiter::new(1)));

/// 每「视频组」一个分P并发信号量。键 = video_semaphore_key 的产物
/// （video_title 分组，番剧整季共享；空标题回退 bvid）。
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

fn get_video_semaphore(group_key: &str, max_pages: usize) -> Arc<Semaphore> {
    let want = clamp_permits(max_pages);
    let mut map = lock_or_recover(&VIDEO_SEMAPHORES);
    map.entry(group_key.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(want)))
        .clone()
}

/// 计算 per-video 分P 限流桶的键（分组依据见 execute_download 中的说明）。
///
/// - `video_title` 非空：以它分组，加 `"t:"` 前缀避免与 bvid 形态的键意外撞桶；
/// - `video_title` 为空：回退 `bvid`（极少数异常提交场景，按单个视频分组）。
fn video_semaphore_key(video_title: &str, bvid: &str) -> String {
    if video_title.is_empty() {
        bvid.to_string()
    } else {
        format!("t:{}", video_title)
    }
}

/// 任务结束后清理 per-video 信号量条目，避免 map 随下载过的不同视频组无限增长。
///
/// 判定：`Arc::strong_count(sem) <= 2` 意为「map 自身持有 1 + 当前调用方持有的 1」，
/// 即没有其他并发任务在用该组的信号量，可安全移除。
///
/// 不用 `available_permits() == want` 的原因：Semaphore 不暴露总容量；且调用方此刻
/// 仍持有未归还的 permit，`available_permits` 必然 < 容量，旧实现因此**永不移除**
/// （map 持续泄漏）。容量错配（用户中途改 max_pages）只影响极窄的并发场景，
/// 且任务结束后本清理会移除条目，下次同组提交时按新设置重建，可自愈。
fn cleanup_video_semaphore(group_key: &str) {
    let mut map = lock_or_recover(&VIDEO_SEMAPHORES);
    if let Some(sem) = map.get(group_key) {
        if Arc::strong_count(sem) <= 2 {
            map.remove(group_key);
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
    subtitle_only: Option<bool>,
    audio_only: Option<bool>,
    video_meta: Option<VideoMeta>,
    owner_name: Option<String>,
) -> Result<(), String> {
    let download_id = sanitize_download_id(&id)?;

    // 前置校验：登录态（避免无凭证任务进队列后才失败，浪费排队）
    // 这里只验证凭证文件存在且可加载，不持有——execute_download 内会重新加载（凭证可能过期需刷新）
    let cred_check = Credential::load().map_err(|e| e.to_string())?;
    if cred_check.is_none() {
        return Err("请先登录".to_string());
    }

    // 前置校验：settings 可读（dispatcher 会重新读，但这里早失败更友好）
    let settings = get_settings().map_err(|e| e.to_string())?;

    // UP 主名（文件名模板 {up}）：优先取 video_meta 里的完整透传；
    // NFO 关闭（video_meta 被下文的门控丢弃）或恢复/重试（DB 只回传 owner_name）时用独立参数。
    let owner_name = video_meta
        .as_ref()
        .map(|m| m.owner_name.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| owner_name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()));

    // 若用户未开启 NFO，丢弃前端透传的 video_meta 节省内存（调度器保存到任务队列里）
    let video_meta = if settings.download_nfo { video_meta } else { None };

    let params = DownloadParams {
        id: download_id.clone(),
        bvid,
        cid,
        title,
        video_title,
        qn,
        ep_id,
        duration,
        subtitle_only: subtitle_only.unwrap_or(false),
        audio_only: audio_only.unwrap_or(false),
        video_meta,
        owner_name,
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
/// 排队任务被移除后不会走 execute_download 收尾流程，这里补发 paused 状态事件，
/// 否则前端列表停留在「排队中」直到手动刷新。
#[tauri::command]
pub fn pause_download(id: String, app: AppHandle) -> Result<bool, String> {
    use tauri::Emitter;
    match manager().pause(&id) {
        crate::download_manager::PauseOutcome::NotFound => Ok(false),
        crate::download_manager::PauseOutcome::Running => Ok(true),
        crate::download_manager::PauseOutcome::Pending => {
            let _ = app.emit(
                "download://state",
                crate::download_manager::DownloadStateChange {
                    id,
                    status: "paused".to_string(),
                },
            );
            Ok(true)
        }
    }
}

/// 暂停全部任务（批量操作）。返回排队中被移除的任务数；
/// 运行中任务由各自收尾流程 emit paused，不在此计数。
#[tauri::command]
pub fn pause_all_downloads(app: AppHandle) -> Result<usize, String> {
    use tauri::Emitter;
    let pending_ids = manager().pause_all();
    // 排队中被移除的任务补发 paused 事件（运行中任务由收尾流程 emit）
    for id in &pending_ids {
        let _ = app.emit(
            "download://state",
            crate::download_manager::DownloadStateChange {
                id: id.clone(),
                status: "paused".to_string(),
            },
        );
    }
    Ok(pending_ids.len())
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
/// `cancel_deletes_tmp`：中断原因是「取消」时为 true（中断后清理 .tmp），「暂停」为 false（保留续传）。
pub async fn execute_download(
    app: &AppHandle,
    params: DownloadParams,
    cancel: &CancellationToken,
    cancel_deletes_tmp: &std::sync::atomic::AtomicBool,
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
        subtitle_only,
        audio_only,
        video_meta,
        owner_name,
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

    // per-video 分P 限流桶键：同一「合集/视频」的任务共享一个桶。
    // 普通多分P视频各分P 的 bvid 相同，天然同桶；但番剧每集是独立 bvid
    // （见 video.rs PageInfo.bvid 注释「番剧每集独立 bvid」），若按 bvid 分桶则
    // 整部番的各集互不限流。video_title（番剧=整季共享的剧集/合集名，普通视频=
    // 视频标题）作为分组键，让同一部番/同一个合集的各集共享分P并发上限。
    // video_title 为空（极少数异常提交）时回退 bvid。
    let video_group_key = video_semaphore_key(&video_title, &bvid);

    // 获取 per-video 分P permit（避免同一视频/番剧分P过多并发触发风控）。
    // acquire 可被取消打断：已暂停/取消的任务不再排队占坑（也少占一个全局并发名额），
    // tokio Semaphore::acquire 是 cancel-safe 的，打断不会丢失许可。
    let video_sem = get_video_semaphore(&video_group_key, max_pages);
    let _video_permit = tokio::select! {
        p = video_sem.acquire() => match p {
            Ok(p) => p,
            Err(e) => return ExecOutcome::Failed(format!("获取分P下载许可失败: {}", e)),
        },
        _ = cancel.cancelled() => {
            log::info!("[download] 等待分P许可时被中断: id={}", download_id);
            return ExecOutcome::Interrupted;
        }
    };

    log::info!(
        "[download] 获得分P许可: id={}, 视频组={} 可用={}",
        download_id, video_group_key, video_sem.available_permits()
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

    // 4. 构建输出文件路径（文件名模板渲染；默认模板 {video_title}/{title} 精确复刻历史布局）
    // 仅音频模式：输出 .m4a/.mp3（按设置）；其余 .mp4
    let ext = if audio_only && !subtitle_only {
        if settings.audio_format == "mp3" { "mp3" } else { "m4a" }
    } else {
        "mp4"
    };
    // video_title 为空时回退 title —— 历史行为（旧 video_folder 逻辑），在构建 ctx 时保留
    let folder_name = if video_title.is_empty() { title.as_str() } else { video_title.as_str() };
    let template_ctx = crate::bilibili::filename::TemplateCtx {
        title: &title,
        video_title: folder_name,
        bvid: &bvid,
        ep: ep_id,
        cid,
        up: owner_name.as_deref(),
    };
    let rel = crate::bilibili::filename::render_filename_template(&settings.filename_template, &template_ctx);
    // 防 Windows MAX_PATH：总长超限时只裁剪最后一段（文件名）。
    // 长度按 UTF-16 码元计（与 truncate_to_fit 内部一致）
    let rel = crate::bilibili::filename::truncate_to_fit(
        &rel,
        download_dir.to_string_lossy().encode_utf16().count(),
        ext.len(),
        240,
    );
    // 注意：不能用 with_extension —— 它会把标题里的点（"foo.bar"）误当扩展名替换
    let output_path = download_dir.join(format!("{rel}.{ext}"));
    // 一次性建好父目录（模板可能引入多级子目录；也修复了无音频 rename 路径不建父目录的问题）
    if let Some(parent) = output_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ExecOutcome::Failed(format!("创建视频目录失败: {}", e));
        }
    }

    // 全局限速：KB/s → B/s（0 = 无限制）。前端单位是 KB/s（千字节/秒），×1024 即可。
    let max_bps = settings.max_download_speed_kbps.saturating_mul(1024);

    // 字幕库模式：跳过视频下载，只取字幕（可选附加弹幕，按全局开关）。
    // 单任务选项优先于全局 download_subtitle（勾选即强制下载字幕）。
    if subtitle_only {
        log::info!("[download] 字幕库模式：跳过视频下载，仅下载字幕: id={}", download_id);
        let aid = url::bvid_to_aid(&bvid);
        let dur = duration.unwrap_or(0);
        let base_path = download_dir.join(&rel);
        let sub_result = download_subtitle_only(
            &download_id, &bvid, cid, aid, dur, &credential,
            &base_path, settings.download_danmaku, &settings,
        ).await;
        cleanup_video_semaphore(&video_group_key);
        return match sub_result {
            Ok(()) => {
                // 与历史语义一致：字幕库模式返回字幕所在目录（output_path 的父目录）
                let containing = output_path.parent().unwrap_or(&download_dir);
                ExecOutcome::Done(containing.to_string_lossy().to_string())
            }
            Err(e) => {
                log::warn!("[download] 字幕库模式失败: id={}, {}", download_id, e);
                ExecOutcome::Failed(e)
            }
        };
    }

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
        settings.parallel_threads, max_bps, audio_only, &settings.audio_format, ep_id,
        &dm_img_str, &dm_cover_img_str, &dm_img_list, &dm_img_inter,
        request_delay_ms, cancel, cancel_deletes_tmp,
    ).await;

    // 1b2fe39 残留修复：permit 以 video_group_key 获取，清理也必须用同一个键，
    // 否则 map 条目永不移除（内存泄漏 + 旧容量分P信号量活到重启，调小设置不自愈）。
    cleanup_video_semaphore(&video_group_key);

    // 取消信号中断：立即返回 Interrupted（run_download 内部按 pause/cancel 区分处理 .tmp）
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
                    settings.parallel_threads, max_bps, audio_only, &settings.audio_format, ep_id,
                    &dm_img_str, &dm_cover_img_str, &dm_img_list, &dm_img_inter,
                    request_delay_ms, cancel, cancel_deletes_tmp,
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
                    &settings,
                )
                .await;
            }

            // 附加下载：NFO 元数据 + 封面图（非致命，仅当开启且前端透传了元数据）
            if settings.download_nfo {
                match &video_meta {
                    Some(meta) => {
                        download_nfo_with_assets(
                            app,
                            &download_id,
                            meta,
                            &settings,
                            &output_path,
                        )
                        .await;
                    }
                    None => {
                        // 恢复/重试场景下 DB 未保存完整元数据，跳过（不影响视频下载）
                        log::warn!(
                            "[download] NFO 开关已开启但缺少元数据，跳过生成: id={}",
                            download_id
                        );
                    }
                }
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
    max_bps: u64,
    audio_only: bool,
    audio_format: &str,
    ep_id: Option<u64>,
    dm_img_str: &str,
    dm_cover_img_str: &str,
    dm_img_list: &str,
    dm_img_inter: &str,
    request_delay_ms: u64,
    cancel: &CancellationToken,
    cancel_deletes_tmp: &std::sync::atomic::AtomicBool,
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
        // 仅音频模式：跳过视频流，只下载音频流并封装为 .m4a/.mp3。
        // 要求 DASH 格式且有独立音频流（legacy durl 是音视频合一，无法分离）。
        if audio_only && streams.has_audio() {
            let audio_temp = download_stream(
                app, download_id, &streams.audio_urls, credential, temp_dir,
                "audio", parallel_threads, &audio_fp, max_bps, cancel,
            ).await?;
            temp_files.push(audio_temp.clone());
            remux_audio(&audio_temp, output_path, audio_format).await?;
        } else if streams.is_legacy_format {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, max_bps, cancel,
            ).await?;
            temp_files.push(video_temp.clone());
            remux_to_mp4(&video_temp, output_path).await?;
        } else if streams.has_audio() {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, max_bps, cancel,
            ).await?;
            temp_files.push(video_temp.clone());
            // 流切换前检查取消
            if cancel.is_cancelled() {
                anyhow::bail!("DOWNLOAD_INTERRUPTED:audio流切换前");
            }
            let audio_temp = download_stream(
                app, download_id, &streams.audio_urls, credential, temp_dir,
                "audio", parallel_threads, &audio_fp, max_bps, cancel,
            ).await?;
            temp_files.push(audio_temp.clone());
            merge_streams(&video_temp, &audio_temp, output_path).await?;
        } else {
            let video_temp = download_stream(
                app, download_id, &streams.video_urls, credential, temp_dir,
                "video", parallel_threads, &video_fp, max_bps, cancel,
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
    // - 正常完成/失败：清理 .tmp
    // - 暂停中断：保留 .tmp 供恢复续传
    // - 取消中断：清理 .tmp（用户明确不要这个任务了，残留数 GB 临时文件违反 manager 契约）
    if !interrupted {
        cleanup_temp_files(&temp_files).await;
    } else if cancel_deletes_tmp.load(std::sync::atomic::Ordering::SeqCst) {
        log::info!(
            "[download] 任务被取消，清理临时文件: id={}, files={}",
            download_id,
            temp_files.len()
        );
        cleanup_temp_files(&temp_files).await;
    } else {
        log::info!(
            "[download] 任务被暂停，保留临时文件供续传: id={}, files={}",
            download_id,
            temp_files.len()
        );
    }

    result
}

/// 附加下载：弹幕（ASS）和字幕（SRT/VTT），非致命。
/// 在视频下载成功后调用，按全局开关决定是否下载。
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
    settings: &AppSettings,
) {
    let client = match build_extras_client() {
        Some(c) => c,
        None => return,
    };

    let base_path = output_path.with_extension("");

    // 弹幕与字幕互相独立，并发执行（原本串行 await 会多耗一次往返）。
    // 两者都借用 client/credential/settings 等不可变引用，可安全并发。
    let danmaku_fut = async {
        if !want_danmaku {
            return;
        }
        let opt = settings.to_danmaku_option();
        match crate::bilibili::danmaku::fetch_danmaku_ass(
            &client, credential, cid, aid, duration_secs, title, &opt, settings.danmaku_history_days,
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
    };
    let subtitle_fut = async {
        if !want_subtitle {
            return;
        }
        // 字幕下载（按 settings.subtitle_format 决定 SRT / VTT）；失败已内部 log，非致命
        let _ = fetch_and_save_subtitles(
            &client, download_id, bvid, cid, aid, credential,
            &base_path, settings,
        )
        .await;
    };
    tokio::join!(danmaku_fut, subtitle_fut);

    let _ = app; // 保留 app 参数供将来扩展（如进度事件）
}

/// 生成 NFO 元数据 + 下载封面图（thumb/fanart），非致命。
/// 在视频下载成功后调用。文件命名：
/// - `<base>.nfo`（与视频同名同目录）
/// - `<base>-thumb.jpg`（封面缩略图，海报）
/// - `<base>-fanart.jpg`（背景图，由 thumb 复制）
/// 其中 `<base>` = output_path 去掉 `.mp4` 扩展名。
async fn download_nfo_with_assets(
    app: &AppHandle,
    download_id: &str,
    meta: &VideoMeta,
    settings: &AppSettings,
    output_path: &std::path::Path,
) {
    let base_path = output_path.with_extension("");
    let nfo_path = output_path.with_extension("nfo");

    // 1. 生成并写入 NFO
    let nfo = crate::bilibili::nfo::MovieNfo { meta, settings }.render();
    match tokio::fs::write(&nfo_path, nfo.as_bytes()).await {
        Ok(()) => log::info!("[download] NFO 保存成功: {}", nfo_path.display()),
        Err(e) => {
            log::warn!("[download] NFO 写入失败(id={}): {}", download_id, e);
            return; // NFO 写不进去，封面图也无意义，直接返回
        }
    }

    // 2. 下载封面图（无 pic URL 则跳过；失败不致命）
    if meta.pic.trim().is_empty() {
        log::info!("[download] 无封面 URL，跳过 thumb/fanart 下载(id={})", download_id);
        let _ = app;
        return;
    }

    let client = match build_extras_client() {
        Some(c) => c,
        None => {
            let _ = app;
            return;
        }
    };

    // base_name 用于拼接 `<base>-thumb.jpg` / `<base>-fanart.jpg`
    let base_name = match base_path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => {
            log::warn!("[download] 无法解析文件名用于 thumb 路径: {}", base_path.display());
            let _ = app;
            return;
        }
    };
    let parent = base_path.parent().unwrap_or_else(|| std::path::Path::new("."));

    let thumb_path = parent.join(format!("{}-thumb.jpg", base_name));
    match fetch_image(&client, &meta.pic, &thumb_path).await {
        Ok(()) => {
            log::info!("[download] 封面 thumb 保存成功: {}", thumb_path.display());
            // 复制 thumb → fanart（背景图复用封面，B站无独立背景图）
            let fanart_path = parent.join(format!("{}-fanart.jpg", base_name));
            if let Err(e) = tokio::fs::copy(&thumb_path, &fanart_path).await {
                log::warn!("[download] fanart 复制失败(id={}): {}", download_id, e);
            }
        }
        Err(e) => {
            log::warn!("[download] 封面 thumb 下载失败(id={}): {}", download_id, e);
        }
    }

    let _ = app;
}

/// 下载图片 URL 并写入本地文件。失败返回 Err（调用方决定是否记录）。
async fn fetch_image(
    client: &reqwest::Client,
    url: &str,
    out_path: &std::path::Path,
) -> Result<(), anyhow::Error> {
    let bytes = client
        .get(url)
        .header("Referer", crate::bilibili::REFERER)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
    }
    tokio::fs::write(out_path, &bytes).await?;
    Ok(())
}

/// 字幕库模式：跳过视频，只下载字幕（可选附加弹幕，按全局开关）。
/// base_path 为不含扩展名的字幕文件前缀（视频未下载，用 title 作为文件名）。
/// Err = 字幕没有产出（列表获取失败 / 无可用字幕 / 全部下载失败），
/// 调用方据此把任务记为失败而不是假完成。
async fn download_subtitle_only(
    download_id: &str,
    bvid: &str,
    cid: i64,
    aid: u64,
    duration_secs: u64,
    credential: &Credential,
    base_path: &std::path::Path,
    want_danmaku: bool,
    settings: &AppSettings,
) -> Result<(), String> {
    let client = match build_extras_client() {
        Some(c) => c,
        None => return Err("创建附加下载客户端失败".to_string()),
    };

    // 字幕库模式强制下载字幕（单任务选项优先于全局开关）
    let saved = fetch_and_save_subtitles(
        &client, download_id, bvid, cid, aid, credential,
        base_path, settings,
    ).await?;
    if saved == 0 {
        return Err("该视频没有可用字幕（或字幕全部下载失败）".to_string());
    }

    // 可选附加弹幕（非致命）
    if want_danmaku {
        let opt = settings.to_danmaku_option();
        match crate::bilibili::danmaku::fetch_danmaku_ass(
            &client, credential, cid, aid, duration_secs, "", &opt, settings.danmaku_history_days,
        )
        .await
        {
            Ok(ass_content) => {
                // 字幕库模式没有视频文件，弹幕写到 base_path.ass
                let dm_path = base_path.with_extension("ass");
                match tokio::fs::write(&dm_path, &ass_content).await {
                    Ok(()) => log::info!("[download] 字幕库模式弹幕保存成功: {}", dm_path.display()),
                    Err(e) => log::warn!("[download] 弹幕写入失败: {}", e),
                }
            }
            Err(e) => {
                log::warn!("[download] 字幕库模式弹幕下载失败(id={}): {}", download_id, e);
            }
        }
    }
    Ok(())
}

/// 构建附加下载（弹幕/字幕）专用 reqwest 客户端
fn build_extras_client() -> Option<reqwest::Client> {
    match reqwest::Client::builder()
        .user_agent(crate::bilibili::USER_AGENT)
        .cookie_store(false)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => Some(c),
        Err(e) => {
            log::warn!("[download] 创建附加下载客户端失败: {}", e);
            None
        }
    }
}

/// 获取字幕列表并逐条保存为 SRT/VTT（按 settings.subtitle_format）。
/// 文件名：<base_path>.<lan>.{srt|vtt}，lan 经 sanitize 防路径穿越。
/// 返回成功保存的字幕条数；列表获取失败返回 Err（细节已内部 log）。
async fn fetch_and_save_subtitles(
    client: &reqwest::Client,
    download_id: &str,
    bvid: &str,
    cid: i64,
    aid: u64,
    credential: &Credential,
    base_path: &std::path::Path,
    settings: &AppSettings,
) -> Result<usize, String> {
    let format = settings.normalized_subtitle_format(); // "srt" | "vtt"
    match crate::bilibili::subtitle::get_subtitle_urls(client, credential, cid, bvid, aid).await {
        Ok(subtitles) => {
            if subtitles.is_empty() {
                log::info!("[download] 该视频无可用字幕(id={}, format={})", download_id, format);
                return Ok(0);
            }
            let mut saved = 0usize;
            for sub in &subtitles {
                let fetch_result = if format == "vtt" {
                    crate::bilibili::subtitle::fetch_subtitle_vtt(client, &sub.subtitle_url).await
                } else {
                    crate::bilibili::subtitle::fetch_subtitle_srt(client, &sub.subtitle_url).await
                };
                match fetch_result {
                    Ok(content) => {
                        // 清洗语言代码，防止路径穿越（sub.lan 来自 API，可能含非法字符）
                        let safe_lan = sanitize_filename(&sub.lan);
                        let out_path = format!("{}.{}.{}", base_path.display(), safe_lan, format);
                        match tokio::fs::write(&out_path, &content).await {
                            Ok(()) => {
                                saved += 1;
                                log::info!(
                                    "[download] 字幕保存成功({}, {}): {}",
                                    sub.lan, format, out_path
                                );
                            }
                            Err(e) => log::warn!("[download] 字幕写入失败({}): {}", sub.lan, e),
                        }
                    }
                    Err(e) => log::warn!("[download] 字幕下载失败({}): {}", sub.lan, e),
                }
            }
            Ok(saved)
        }
        Err(e) => {
            log::warn!("[download] 获取字幕列表失败(id={}): {}", download_id, e);
            Err(format!("获取字幕列表失败: {}", e))
        }
    }
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
    fn limiter_grows_capacity_in_place() {
        let mut limiter = GlobalLimiter::new(2);
        let s1 = limiter.ensure(2);
        let s2 = limiter.ensure(4); // 容量变化 → 原地增容（同一信号量实例）
        assert!(
            Arc::ptr_eq(&s1, &s2),
            "容量调整不应更换信号量实例（更换会让旧 permit 归还到死信号量）"
        );
        assert_eq!(s2.available_permits(), 4);
    }

    /// 缩容：差额被扣留（永久持有），available 立即反映新上限。
    #[test]
    fn limiter_shrinks_capacity_by_reserving() {
        let mut limiter = GlobalLimiter::new(4);
        let _s = limiter.ensure(4);
        let s2 = limiter.ensure(2);
        assert_eq!(s2.available_permits(), 2, "4→2 应扣留 2 个许可");
        // 再增容：先归还扣留的许可
        let s3 = limiter.ensure(4);
        assert_eq!(s3.available_permits(), 4, "2→4 应归还扣留的许可恢复到 4");
    }

    /// 缩容时运行中任务占用的许可此刻拿不到：只扣留能拿到的部分，
    /// 不得因此把 available 扣成负数或死锁（剩余差额由后台补扣，异步不在此测）。
    #[test]
    fn limiter_shrink_with_inflight_holders_only_reserves_available() {
        let mut limiter = GlobalLimiter::new(4);
        let s1 = limiter.ensure(4);
        let _held = s1.try_acquire().expect("应能获取许可"); // 模拟 1 个任务在跑
        let s2 = limiter.ensure(2); // 4→2：需要扣 2，实际只有 3 可用
        assert_eq!(
            s2.available_permits(),
            1,
            "总 4 - 运行中 1 - 扣留 2 = 1：瞬时并发 1 运行 + 1 新任务 = 2，不超新上限"
        );
    }

    #[test]
    fn limiter_clamps_zero_capacity_so_it_never_deadlocks() {
        let mut limiter = GlobalLimiter::new(1);
        let s = limiter.ensure(0); // 0 必须 clamp 到 1
        assert_eq!(s.available_permits(), 1);
        assert!(s.try_acquire().is_ok(), "clamp 后至少应有 1 个可获取许可");
    }

    /// 分P限流桶键：番剧各集 bvid 不同但 video_title（剧集/合集名）整季共享 → 必须同桶；
    /// 不同标题不同桶；空标题回退 bvid；"t:" 前缀防止标题与 bvid 键撞桶。
    #[test]
    fn video_semaphore_key_groups_shared_title_but_not_bvid() {
        // 番剧各集：bvid 各不相同，video_title 相同 → 同桶（整部番共享分P并发上限）
        assert_eq!(
            video_semaphore_key("凡人修仙传", "BV1aaaa"),
            video_semaphore_key("凡人修仙传", "BV1bbbb"),
        );
        // 不同标题 → 不同桶
        assert_ne!(
            video_semaphore_key("凡人修仙传", "BV1aaaa"),
            video_semaphore_key("其它动画", "BV1aaaa"),
        );
        // 空标题回退 bvid：同 bvid 同桶，不同 bvid 不同桶
        assert_eq!(video_semaphore_key("", "BV1aaaa"), "BV1aaaa");
        assert_ne!(
            video_semaphore_key("", "BV1aaaa"),
            video_semaphore_key("", "BV1bbbb"),
        );
        // "t:" 前缀：标题恰为 bvid 形态时也不会与 bvid 键撞桶
        assert_ne!(video_semaphore_key("BV1aaaa", "BV1bbbb"), "BV1aaaa");
    }
}
