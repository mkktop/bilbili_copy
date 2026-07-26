import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DownloadTask } from "../types";
import { DOWNLOAD_PROGRESS_THROTTLE_MS, DOWNLOAD_DB_WRITE_MS } from "../lib/constants";

/** download://progress 事件载荷 */
interface DownloadProgress {
  id: string;
  label: string;
  downloaded: number;
  total: number;
  percent: number;
}

/** download://complete 事件载荷 */
interface DownloadComplete {
  id: string;
  output_path: string;
  /** 最终文件字节数（统计用，后端在 finalize_outcome 中由 std::fs::metadata 计算） */
  size: number;
}

/** download://error 事件载荷 */
interface DownloadError {
  id: string;
  error: string;
}

/** download://state 事件载荷：任务状态变化（queued/downloading/paused/cancelled） */
interface DownloadStateChange {
  id: string;
  status: "queued" | "downloading" | "paused" | "cancelled";
}

interface Options {
  setDownloads: Dispatch<SetStateAction<DownloadTask[]>>;
  /** 触发风控验证时回调（弹出验证码对话框 + toast 提示） */
  onRiskControl: (vVoucher: string) => void;
  /** 下载失败时回调（toast 提示） */
  onDownloadError: (error: string) => void;
}

/**
 * 下载事件监听 Hook：订阅后端 5 个下载事件并维护 downloads 列表状态。
 *
 * 从 App.tsx 抽出，职责：
 * - progress：UI 更新按 DOWNLOAD_PROGRESS_THROTTLE_MS 节流；落库按更稀疏的
 *   DOWNLOAD_DB_WRITE_MS 节流（中途进度仅供重启后恢复展示，无需高频写 SQLite）
 * - complete/error/state：实时更新 UI 并落库（不节流）
 * - risk_control：透传给调用方弹验证码
 *
 * 返回 downloadingIds：活跃任务 id 集合（queued/downloading），
 * 供 handleDownload 做重复提交防抖。
 */
export function useDownloadEvents({ setDownloads, onRiskControl, onDownloadError }: Options): {
  downloadingIds: MutableRefObject<Set<string>>;
} {
  const downloadingIds = useRef<Set<string>>(new Set());
  // 每个任务最近一次 UI 更新 / 进度落库的时间戳（分开节流：落库比 UI 更稀疏）
  const lastUiUpdate = useRef<Map<string, number>>(new Map());
  const lastDbWrite = useRef<Map<string, number>>(new Map());

  // 回调经 ref 转发：监听器只注册一次，同时始终调用最新的回调（避免闭包过期/重复订阅）
  const onRiskControlRef = useRef(onRiskControl);
  onRiskControlRef.current = onRiskControl;
  const onDownloadErrorRef = useRef(onDownloadError);
  onDownloadErrorRef.current = onDownloadError;

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    /** 任务终态/暂停时清理节流与防抖记录 */
    const cleanupTask = (id: string) => {
      downloadingIds.current.delete(id);
      lastUiUpdate.current.delete(id);
      lastDbWrite.current.delete(id);
    };

    const setup = async () => {
      const fns = await Promise.all([
        listen<DownloadProgress>("download://progress", (event) => {
          if (cancelled) return;
          const { id, percent, label } = event.payload;
          const phase = label === "audio" ? ("audio" as const) : ("video" as const);
          // UI 节流：后端虽按 512KB 节流发射 progress，但并行分片仍会产生每秒数十次事件；
          // 这里把 setDownloads 纳入节流，避免每个事件都全量重渲染整个 App（downloads 在顶层 state）。
          // 下载完成由独立的 complete 监听器负责最终落库与置 100%，不受此节流影响。
          const now = Date.now();
          const lastUi = lastUiUpdate.current.get(id) ?? 0;
          if (now - lastUi < DOWNLOAD_PROGRESS_THROTTLE_MS) return;
          lastUiUpdate.current.set(id, now);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "downloading" as const, progress: percent, phase } : d
            )
          );
          // 落库节流（比 UI 更稀疏）：中途进度仅在应用重启后恢复展示时用到，
          // 高频写库只会争抢 SQLite 锁。暂停/出错/完成时的最终状态由对应监听器实时落库。
          const lastDb = lastDbWrite.current.get(id) ?? 0;
          if (now - lastDb < DOWNLOAD_DB_WRITE_MS) return;
          lastDbWrite.current.set(id, now);
          invoke("update_download_status", { id, status: "downloading", progress: percent, phase, errorMsg: null, outputPath: null }).catch(() => {});
        }),
        listen<DownloadComplete>("download://complete", (event) => {
          if (cancelled) return;
          const { id, output_path, size } = event.payload;
          cleanupTask(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "done" as const, progress: 100, outputPath: output_path } : d
            )
          );
          invoke("update_download_status", { id, status: "done", progress: 100, phase: null, errorMsg: null, outputPath: output_path, size }).catch(() => {});
        }),
        listen<DownloadError>("download://error", (event) => {
          if (cancelled) return;
          const { id, error } = event.payload;
          cleanupTask(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "error" as const, errorMsg: error } : d
            )
          );
          invoke("update_download_status", { id, status: "error", progress: null, phase: null, errorMsg: error, outputPath: null }).catch(() => {});
          onDownloadErrorRef.current(error);
        }),
        listen<{ v_voucher: string }>("download://risk_control", (event) => {
          if (cancelled) return;
          console.warn("[risk] 收到风控事件");
          onRiskControlRef.current(event.payload.v_voucher);
        }),
        listen<DownloadStateChange>("download://state", (event) => {
          if (cancelled) return;
          const { id, status } = event.payload;
          if (status === "downloading") {
            // dispatcher 拿到 permit 开始执行：UI 从 queued → downloading
            setDownloads((prev) =>
              prev.map((d) => (d.id === id ? { ...d, status: "downloading" as const } : d))
            );
            invoke("update_download_status", { id, status: "downloading", progress: null, phase: null, errorMsg: null, outputPath: null }).catch(() => {});
          } else if (status === "paused") {
            cleanupTask(id);
            setDownloads((prev) =>
              prev.map((d) => (d.id === id ? { ...d, status: "paused" as const } : d))
            );
            invoke("update_download_status", { id, status: "paused", progress: null, phase: null, errorMsg: null, outputPath: null }).catch(() => {});
          } else if (status === "cancelled") {
            cleanupTask(id);
            // 取消即从列表移除（.tmp 已被后端清理，记录也删除）
            setDownloads((prev) => prev.filter((d) => d.id !== id));
            invoke("delete_download_history", { id }).catch(() => {});
          }
        }),
      ]);
      if (cancelled) {
        fns.forEach((fn) => fn());
      } else {
        unlisteners.push(...fns);
      }
    };

    setup();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
    // setDownloads 是 useState 的 setter（identity 稳定）；回调经 ref 转发，无需依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { downloadingIds };
}
