import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 字节数 → 可读字符串（B / KB / MB / GB，保留 1 位小数） */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 秒数 → 人类可读时长（如 3h 25m / 12m 30s / 45s）。
 *  注意：types.ts 另有一个同名的 formatDuration 返回冒号格式（适合视频播放时长），
 *  这里用 formatDurationHuman 区分，统计面板等大数场景用本函数更直观。 */
export function formatDurationHuman(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
