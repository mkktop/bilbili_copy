//! 下载任务调度器（DownloadManager）。
//!
//! 解耦「任务提交」与「任务执行」，提供：
//! - 优先级排队（download_video 命令 submit 后立即返回，任务进队列等待 dispatcher 取出执行）
//! - 运行时暂停/取消（通过 CancellationToken 中断下载循环，保留/清理 .tmp）
//! - 运行时调整优先级（仅对排队中未开始的任务生效）
//!
//! 核心流程：
//! ```text
//! download_video 命令 ──submit──> pending 队列 + notify
//! dispatcher 循环: pop 最高优先级 pending → 检查 cancel → acquire global permit
//!                  → 再次检查 cancel → 注册 running → spawn execute_download
//! execute_download: 跑实际下载 → 检查 target(Pausing/Cancelling) → emit 状态
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::commands::download::{ensure_global_semaphore, execute_download, ExecOutcome};
use crate::commands::settings::get_settings;

/// 取消目标状态：决定运行中任务退出时如何处理 .tmp 与 emit 哪种状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetState {
    /// 正常运行（无取消请求）
    Running,
    /// 暂停：中断下载但保留 .tmp/.meta，供恢复时续传
    Pausing,
    /// 取消：中断下载并清理 .tmp/.meta
    Cancelling,
}

/// 排队中的待执行任务。
struct PendingTask {
    id: String,
    params: DownloadParams,
    priority: i32,
    /// 提交顺序（同优先级 FIFO）。单调递增。
    seq: u64,
    cancel: CancellationToken,
    /// 中断后是否清理 .tmp：cancel 置 true，pause 保持 false。
    /// 独立于 CancellationToken 存在——token 只表达「停止」，不表达「为什么停」。
    delete_tmp: Arc<AtomicBool>,
}

/// 运行中的任务及其取消控制句柄。
struct RunningTask {
    cancel: CancellationToken,
    delete_tmp: Arc<AtomicBool>,
    target: Mutex<TargetState>,
}

struct ManagerInner {
    pending: Vec<PendingTask>,
    running: HashMap<String, RunningTask>,
    /// 同 priority 下按 seq 升序，配合稳定排序保证 FIFO。
    seq_counter: u64,
}

/// 全局调度器单例。在 lib.rs setup 时 dispatcher 循环读取它。
static MANAGER: Lazy<DownloadManager> = Lazy::new(DownloadManager::new);

/// 获取全局调度器实例。
pub fn manager() -> &'static DownloadManager {
    &MANAGER
}

/// NFO 元数据快照：由前端从已解析的 ParsedVideoInfo 透传，供下载完成后生成 .nfo + 封面图。
/// 仅当用户在设置里开启 NFO 时前端会传入；恢复/重试场景因 DB 不保存完整元数据，传 None 跳过 NFO。
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct VideoMeta {
    pub bvid: String,
    pub title: String,
    pub desc: String,
    pub pic: String,
    pub owner_mid: u64,
    pub owner_name: String,
    pub owner_face: String,
    pub duration: u64,
    pub pubdate: i64,
    pub view_count: u64,
    pub like_count: u64,
    /// 弹幕数（当前 NFO 模板未使用，保留供未来扩展与前端透传一致性校验）
    #[allow(dead_code)]
    pub danmaku_count: u64,
    /// 标签（普通视频来自 tag API，番剧来自 season API 的 styles），写入 NFO <genre>
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 任务参数快照：download_video 命令把校验后的参数打包成它，提交给调度器。
#[derive(Clone)]
pub struct DownloadParams {
    pub id: String,
    pub bvid: String,
    pub cid: i64,
    pub title: String,
    pub video_title: String,
    pub qn: Option<i64>,
    pub ep_id: Option<u64>,
    pub duration: Option<u64>,
    /// 字幕库模式：跳过视频下载，仅下载字幕（可选附加弹幕）。
    /// 单任务选项，不持久化到 DB（恢复/重试按普通视频下载处理）。
    pub subtitle_only: bool,
    /// 仅音频模式：跳过视频下载，只下载音频流并封装为 .m4a/.mp3。
    /// 单任务选项，不持久化到 DB。与 subtitle_only 互斥（subtitle_only 优先）。
    pub audio_only: bool,
    /// NFO 元数据快照（前端透传，用于生成 .nfo 和下载封面）。None = 不生成 NFO。
    pub video_meta: Option<VideoMeta>,
    /// UP 主名（文件名模板 `{up}` 占位符用）。一等参数而非仅取自 video_meta：
    /// NFO 关闭时 video_meta 会被丢弃，且恢复/重试场景 DB 只回传它而非完整 meta。
    pub owner_name: Option<String>,
}

/// `download://state` 事件载荷：通知前端任务状态变化（queued/downloading/paused/cancelled）。
#[derive(Clone, Serialize)]
pub struct DownloadStateChange {
    pub id: String,
    pub status: String,
}

/// 调度器公开返回给命令层的结果。
pub enum SubmitOutcome {
    /// 已加入队列（或同一 id 正在排队/运行中——重复提交被合并）
    Queued,
    /// 提交阶段就失败（如读取设置、加锁异常），命令应立即返回 Err 给前端。
    /// 目前 submit 内部不会失败（去重返回 Queued），保留以便未来扩展。
    #[allow(dead_code)]
    Failed(String),
}

pub struct DownloadManager {
    inner: Mutex<ManagerInner>,
    /// 唤醒 dispatcher：submit / cancel(对排队任务) / set_priority 后 notify
    notify: Notify,
}

impl DownloadManager {
    fn new() -> Self {
        Self {
            inner: Mutex::new(ManagerInner {
                pending: Vec::new(),
                running: HashMap::new(),
                seq_counter: 0,
            }),
            notify: Notify::new(),
        }
    }

    /// 提交一个下载任务到队列。默认优先级 0（普通），数值越大越优先。
    pub fn submit(&self, params: DownloadParams, priority: i32) -> SubmitOutcome {
        let id = params.id.clone();

        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(), // 中毒也恢复，不拖垮调度
        };

        // 同 id 去重：已在排队或运行中则不再重复入队（前端 downloadingIds 也会挡，这里兜底）
        if inner.pending.iter().any(|t| t.id == id) || inner.running.contains_key(&id) {
            log::info!("[manager] 任务已在队列/运行中，忽略重复提交: id={}", id);
            return SubmitOutcome::Queued;
        }

        let seq = inner.seq_counter;
        inner.seq_counter += 1;
        let cancel = CancellationToken::new();
        let delete_tmp = Arc::new(AtomicBool::new(false));
        inner.pending.push(PendingTask {
            id: id.clone(),
            params,
            priority,
            seq,
            cancel,
            delete_tmp,
        });

        log::info!(
            "[manager] 任务入队: id={}, priority={}, seq={}, 队列长度={}",
            id, priority, seq, inner.pending.len()
        );

        drop(inner);
        // 唤醒 dispatcher 去取任务
        self.notify.notify_one();
        SubmitOutcome::Queued
    }

    /// 暂停任务。
    /// - 排队中：直接从队列移除（还未开始，无需中断），返回 true 表示「已暂停」。
    /// - 运行中：设 target=Pausing 并触发 cancel，execute_download 退出时保留 .tmp 并 emit paused。
    /// - 不存在：返回 false。
    pub fn pause(&self, id: &str) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };

        // 排队中：移出队列即可（它从未开始下载，没有 .tmp 需要保留）
        if let Some(pos) = inner.pending.iter().position(|t| t.id == id) {
            inner.pending.remove(pos);
            log::info!("[manager] 暂停排队中任务: id={}", id);
            return true;
        }

        // 运行中：标记 Pausing 并触发 cancel（.tmp 保留供续传，delete_tmp 保持 false）
        if let Some(task) = inner.running.get(id) {
            if let Ok(mut target) = task.target.lock() {
                *target = TargetState::Pausing;
            }
            task.cancel.cancel();
            log::info!("[manager] 请求暂停运行中任务: id={}", id);
            return true;
        }

        log::warn!("[manager] 暂停失败，任务不存在: id={}", id);
        false
    }

    /// 取消任务（删除排队/中断运行）。
    /// - 排队中：直接从队列移除。
    /// - 运行中：设 target=Cancelling 并触发 cancel，execute_download 退出时清理 .tmp 并 emit cancelled。
    /// - 不存在：返回 false。
    pub fn cancel(&self, id: &str) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };

        if let Some(pos) = inner.pending.iter().position(|t| t.id == id) {
            inner.pending.remove(pos);
            log::info!("[manager] 取消排队中任务: id={}", id);
            return true;
        }

        if let Some(task) = inner.running.get(id) {
            if let Ok(mut target) = task.target.lock() {
                *target = TargetState::Cancelling;
            }
            // 取消（非暂停）：中断后要清理 .tmp/.meta，置标志让 run_download 在
            // 中断处理时删除临时文件而不是保留续传。
            task.delete_tmp.store(true, Ordering::SeqCst);
            task.cancel.cancel();
            log::info!("[manager] 请求取消运行中任务: id={}", id);
            return true;
        }

        log::warn!("[manager] 取消失败，任务不存在: id={}", id);
        false
    }

    /// 调整排队中任务的优先级。数值越大越优先。运行中任务无法调整（已在执行）。
    /// 返回是否成功（任务存在且在排队中）。
    pub fn set_priority(&self, id: &str, priority: i32) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };

        if let Some(task) = inner.pending.iter_mut().find(|t| t.id == id) {
            task.priority = priority;
            log::info!("[manager] 调整优先级: id={}, priority={}", id, priority);
            true
        } else {
            log::warn!(
                "[manager] 调整优先级失败（任务不存在或已运行）: id={}",
                id
            );
            false
        }
    }

    /// 从 pending 中弹出最高优先级任务。同优先级按提交顺序（seq 升序）FIFO。
    /// 返回 None 表示队列空。仅测试使用（dispatcher 走 claim_task 原子认领）。
    #[cfg(test)]
    fn pop_highest(&self) -> Option<PendingTask> {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if inner.pending.is_empty() {
            return None;
        }
        // 找到 (priority 最高, seq 最小) 的索引
        let best_idx = inner
            .pending
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.priority
                    .cmp(&b.priority)
                    .then(a.seq.cmp(&b.seq).reverse())
            })
            .map(|(i, _)| i)?;
        Some(inner.pending.remove(best_idx))
    }

    /// 原子认领：在同一次锁临界区内完成「取出最高优先级任务 + 注册 running」。
    ///
    /// 拆成两段（pop 后释放锁、再重新加锁 insert）会留下取消请求落空的窗口：
    /// cancel 在窗口内既找不到 pending 也找不到 running → 返回 false「任务不存在」，
    /// 而任务实际会继续执行直到下载完，用户被告知取消失败。
    /// 认领后 token 已注册在 running 里，任何 cancel/pause 都能命中。
    fn claim_task(&self) -> Option<PendingTask> {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if inner.pending.is_empty() {
            return None;
        }
        let best_idx = inner
            .pending
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.priority
                    .cmp(&b.priority)
                    .then(a.seq.cmp(&b.seq).reverse())
            })
            .map(|(i, _)| i)?;
        let task = inner.pending.remove(best_idx);
        inner.running.insert(
            task.id.clone(),
            RunningTask {
                cancel: task.cancel.clone(),
                delete_tmp: Arc::clone(&task.delete_tmp),
                target: Mutex::new(TargetState::Running),
            },
        );
        Some(task)
    }

    /// dispatcher 主循环。在 lib.rs setup 时 spawn 一次，常驻运行。
    /// 每轮：读 settings → acquire 全局 permit（并发满时阻塞）→ pop 最高优先级任务
    ///       → 检查 cancel → 注册 running → spawn execute_download（permit 移入任务持有，
    ///       直到任务结束才释放，从而真正限制并发任务数）→ 等下一个 notify。
    pub async fn run_dispatcher(&self, app: AppHandle) {
        log::info!("[manager] dispatcher 启动");
        loop {
            // 读取全局并发信号量（容量随 settings 动态调整）
            let settings = match get_settings() {
                Ok(s) => s,
                Err(e) => {
                    // get_settings 正常不会失败（解析失败回退默认值），此处仅兜底防死循环
                    log::error!("[manager] 读取设置失败: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            let global_sem = ensure_global_semaphore(&settings);

            // 先等全局 permit 再取任务。acquire_owned：permit 不借用局部变量，
            // 可随任务 move 进 spawn 的 'static 闭包长期持有（见下方 spawn 注释）。
            // 并发满时阻塞在此；期间新到的高优先级任务仍在队列里，拿到 permit 后
            // pop 时优先 —— pop 在 acquire 之后，排队优先级始终生效。
            let _permit = match global_sem.acquire_owned().await {
                Ok(p) => p,
                Err(e) => {
                    log::error!("[manager] 获取全局 permit 失败: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };

            // 原子认领一个待执行任务（pop + 注册 running 在同一临界区，
            // 消除认领窗口内的取消竞态，见 claim_task 注释）
            let task = match self.claim_task() {
                Some(t) => t,
                None => {
                    // 队列空：先归还 permit（不占并发名额干等），再等待 submit 唤醒
                    drop(_permit);
                    self.notify.notified().await;
                    continue;
                }
            };

            // 认领后立即检查：等待 permit 期间 cancel 已触发 → 撤销注册直接结束。
            // cancel() 此时已能命中 running（返回 true 并置好 target/token），
            // 这里补发 cancelled 状态事件让前端列表落地。
            if task.cancel.is_cancelled() {
                log::info!("[manager] 任务出队即已取消，跳过: id={}", task.id);
                {
                    let mut inner = match self.inner.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    inner.running.remove(&task.id);
                }
                let _ = app.emit(
                    "download://state",
                    DownloadStateChange {
                        id: task.id.clone(),
                        status: "cancelled".to_string(),
                    },
                );
                continue;
            }

            // 通知前端：任务开始下载
            let _ = app.emit(
                "download://state",
                DownloadStateChange {
                    id: task.id.clone(),
                    status: "downloading".to_string(),
                },
            );

            let task_id = task.id.clone();
            let task_cancel = task.cancel.clone();
            let task_delete_tmp = Arc::clone(&task.delete_tmp);
            let app_clone = app.clone();
            // 在 params 被 move 进 execute_download 之前克隆标题，供完成时发桌面通知
            let task_title = task.params.title.clone();

            // spawn 执行；执行结束后清理 running 表。
            // 全局 permit 一并移入任务内持有：execute_download 运行期间持续占用一个并发名额，
            // 任务结束（含失败/暂停/取消）后才释放 —— max_concurrent_downloads 由此真正限制
            // 同时运行的任务数（旧实现 permit 在循环体末尾即释放，全局并发限制形同虚设）。
            tauri::async_runtime::spawn(async move {
                let _permit = _permit; // 持有全局 permit 直到本任务收尾
                let params = task.params;
                let outcome =
                    execute_download(&app_clone, params, &task_cancel, &task_delete_tmp).await;

                // 读 target 并从 running 表移除该任务。
                // 锁中毒时也恢复内部数据（与项目其它锁处理一致），避免一次 panic 永久拖垮调度。
                let target = {
                    let mgr = manager();
                    let mut guard = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
                    let t = guard
                        .running
                        .get(&task_id)
                        .and_then(|rt| rt.target.lock().ok().map(|tg| *tg))
                        .unwrap_or(TargetState::Running);
                    guard.running.remove(&task_id);
                    t
                };

                finalize_outcome(&app_clone, &task_id, &task_title, outcome, target).await;
            });
        }
    }
}

/// 根据执行结果与目标状态，emit 对应事件。
/// - 正常完成 → download://complete
/// - 真实失败 → download://error
/// - 暂停中断 → download://state(ppaused)，.tmp 已被 execute_download 保留
/// - 取消中断 → download://state(cancelled)，.tmp 已被 execute_download 清理
async fn finalize_outcome(
    app: &AppHandle,
    id: &str,
    title: &str,
    outcome: ExecOutcome,
    target: TargetState,
) {
    match (outcome, target) {
        (ExecOutcome::Done(path), _) => {
            // 完成时统计最终文件大小（统计面板用）。
            // 仅对普通文件统计：字幕库模式返回的是目录（目录的 len 是文件系统
            // 内部值，无意义），跳过记 0，避免统计面板虚增几 KB 的假大小。
            let size = std::fs::metadata(&path)
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .unwrap_or(0);
            let _ = app.emit(
                "download://complete",
                crate::bilibili::download::DownloadComplete {
                    id: id.to_string(),
                    output_path: path,
                    size,
                },
            );

            // 下载完成桌面通知：根据设置决定是否发送（窗口最小化到托盘时尤其有用）。
            // 读 settings.json；失败时静默（不影响下载主流程）。
            let notify = crate::commands::settings::load_settings().notify_on_complete;
            if notify {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification()
                    .builder()
                    .title("下载完成")
                    .body(if title.is_empty() { "视频已下载完成".to_string() } else { format!("《{}》已下载完成", title) })
                    .show();
            }
        }
        (ExecOutcome::Failed(err), _) => {
            // 风控等非中断错误
            let _ = app.emit(
                "download://error",
                crate::bilibili::download::DownloadError {
                    id: id.to_string(),
                    error: err,
                },
            );
        }
        // 中断类结果：exec 返回的 err 带 INTERRUPTED 前缀
        (ExecOutcome::Interrupted, TargetState::Pausing) => {
            let _ = app.emit(
                "download://state",
                DownloadStateChange {
                    id: id.to_string(),
                    status: "paused".to_string(),
                },
            );
        }
        (ExecOutcome::Interrupted, TargetState::Cancelling) => {
            let _ = app.emit(
                "download://state",
                DownloadStateChange {
                    id: id.to_string(),
                    status: "cancelled".to_string(),
                },
            );
        }
        // 中断但 target 仍是 Running（理论上不应发生：cancel 不触发则不会 Interrupted）
        (ExecOutcome::Interrupted, TargetState::Running) => {
            log::warn!(
                "[manager] 任务中断但 target=Running，按取消处理: id={}",
                id
            );
            let _ = app.emit(
                "download://state",
                DownloadStateChange {
                    id: id.to_string(),
                    status: "cancelled".to_string(),
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(id: &str) -> DownloadParams {
        DownloadParams {
            id: id.to_string(),
            bvid: "BV1xx".into(),
            cid: 1,
            title: id.into(),
            video_title: "v".into(),
            qn: None,
            ep_id: None,
            duration: None,
            subtitle_only: false,
            audio_only: false,
            video_meta: None,
            owner_name: None,
        }
    }

    #[test]
    fn submit_and_pop_priority_order() {
        let mgr = DownloadManager::new();
        // 低优先级先提交，高优先级后提交 → pop 应先取高优先级
        mgr.submit(params("low"), 0);
        mgr.submit(params("high"), 10);
        mgr.submit(params("mid"), 5);

        let first = mgr.pop_highest().unwrap();
        assert_eq!(first.id, "high");
        let second = mgr.pop_highest().unwrap();
        assert_eq!(second.id, "mid");
        let third = mgr.pop_highest().unwrap();
        assert_eq!(third.id, "low");
        assert!(mgr.pop_highest().is_none());
    }

    #[test]
    fn same_priority_is_fifo() {
        let mgr = DownloadManager::new();
        mgr.submit(params("a"), 0);
        mgr.submit(params("b"), 0);
        mgr.submit(params("c"), 0);

        assert_eq!(mgr.pop_highest().unwrap().id, "a");
        assert_eq!(mgr.pop_highest().unwrap().id, "b");
        assert_eq!(mgr.pop_highest().unwrap().id, "c");
    }

    #[test]
    fn duplicate_submit_is_merged() {
        let mgr = DownloadManager::new();
        let outcome = mgr.submit(params("dup"), 0);
        assert!(matches!(outcome, SubmitOutcome::Queued));
        // 再次提交同一 id：不重复入队
        let outcome2 = mgr.submit(params("dup"), 0);
        assert!(matches!(outcome2, SubmitOutcome::Queued));
        assert_eq!(mgr.inner.lock().unwrap().pending.len(), 1);
    }

    #[test]
    fn pause_removes_pending_task() {
        let mgr = DownloadManager::new();
        mgr.submit(params("a"), 0);
        assert!(mgr.pause("a"));
        assert!(mgr.pop_highest().is_none(), "暂停后队列应为空");
    }

    #[test]
    fn cancel_removes_pending_task() {
        let mgr = DownloadManager::new();
        mgr.submit(params("a"), 0);
        assert!(mgr.cancel("a"));
        assert!(mgr.pop_highest().is_none());
    }

    #[test]
    fn set_priority_changes_order() {
        let mgr = DownloadManager::new();
        mgr.submit(params("a"), 0);
        mgr.submit(params("b"), 0);
        // 把 b 提为高优先级
        assert!(mgr.set_priority("b", 10));
        assert_eq!(mgr.pop_highest().unwrap().id, "b");
        assert_eq!(mgr.pop_highest().unwrap().id, "a");
    }

    #[test]
    fn set_priority_fails_for_unknown_task() {
        let mgr = DownloadManager::new();
        assert!(!mgr.set_priority("nope", 10));
    }
}
