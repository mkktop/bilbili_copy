//! 全局下载限速器（令牌桶）。
//!
//! 所有下载线程（单线程 download_single + 并行分片 download_range_segment）
//! 在写入磁盘前向全局令牌桶申请字节额度，保证所有任务**合计**不超过设定速度。
//!
//! 算法：滑动窗口令牌桶。维护「上次补充时间」与「当前可用字节」，
//! 每次 acquire 时先按经过的时间补充令牌（上限为 max_bps，即 1 秒的量），
//! 再消费；若不足则 sleep 到够为止。

use std::sync::OnceLock;
use std::time::Instant;
use tokio::sync::Mutex;

/// 全局限速器单例（进程级共享）。
static GLOBAL_LIMITER: OnceLock<RateLimiter> = OnceLock::new();

/// 令牌桶限速器。
pub struct RateLimiter {
    /// (当前可用字节, 上次补充时间)
    inner: Mutex<(u64, Instant)>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            // 初始可用 0，首次 acquire 会补满
            inner: Mutex::new((0, Instant::now())),
        }
    }

    /// 申请 `bytes` 字节额度。
    ///
    /// @param bytes 本次 chunk 字节数
    /// @param max_bps 最大速度（字节/秒）；0 = 无限制（直接返回，零开销）
    pub async fn acquire(&self, bytes: u64, max_bps: u64) {
        if max_bps == 0 {
            return;
        }
        let mut guard = self.inner.lock().await;
        let (available, last) = *guard;

        // 按经过时间补充令牌（令牌上限 = 1 秒的量，避免长时间不调用后突发）
        let now = Instant::now();
        let elapsed = now.duration_since(last).as_secs_f64();
        let refilled = (available as f64 + elapsed * max_bps as f64) as u64;
        let available = refilled.min(max_bps);

        if available >= bytes {
            // 额度够，直接消费
            *guard = (available - bytes, now);
            return;
        }

        // 额度不足：先用掉剩余，再 sleep 到补足差额
        let deficit = bytes - available;
        let wait_secs = deficit as f64 / max_bps as f64;
        *guard = (0, now); // 标记已消费（可用归零，时间重置）
        drop(guard); // 释放锁再 sleep，不阻塞其他线程补充

        if wait_secs > 0.0 {
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait_secs)).await;
        }
    }
}

/// 获取全局限速器单例。
pub fn global_limiter() -> &'static RateLimiter {
    GLOBAL_LIMITER.get_or_init(RateLimiter::new)
}
