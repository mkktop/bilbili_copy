import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "upToDate"
  | "error";

/** 更新渠道：r2 = 默认（国内直连），github = 备用 */
export type UpdateChannel = "r2" | "github";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  /** 实际命中的渠道（端点回退后可能与请求渠道不同） */
  channel: UpdateChannel;
}

/** 后端 update://progress 事件负载 */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  /** 字节/秒 */
  speed: number;
  channel: UpdateChannel;
}

export const UPDATE_PROGRESS_EVENT = "update://progress";
export const UPDATE_DOWNLOADED_EVENT = "update://downloaded";

export function channelLabel(channel?: string | null): string {
  return channel === "github" ? "GitHub" : "R2（copy.kaikun.top）";
}

const JUST_UPDATED_KEY = "bilibili_dl:update:justUpdatedTo";

/** Check if we just updated to a new version (called before auto-check) */
export async function justUpdated(): Promise<boolean> {
  const stored = localStorage.getItem(JUST_UPDATED_KEY);
  if (!stored) return false;
  const current = await getVersion();
  if (stored === current) {
    // We just updated to this version, clear the flag
    localStorage.removeItem(JUST_UPDATED_KEY);
    return true;
  }
  // Version mismatch (shouldn't happen), clear stale flag
  localStorage.removeItem(JUST_UPDATED_KEY);
  return false;
}

/** 按指定渠道检查更新（后端按端点优先级回退，返回实际命中的渠道） */
export async function checkForUpdate(
  channel: UpdateChannel
): Promise<{ available: boolean; info?: UpdateInfo }> {
  const info = await invoke<{
    version: string;
    currentVersion: string;
    notes: string | null;
    pubDate: string | null;
    channel: string;
  } | null>("check_app_update", { channel });

  if (!info) return { available: false };

  return {
    available: true,
    info: {
      version: info.version,
      currentVersion: info.currentVersion,
      date: info.pubDate ?? undefined,
      body: info.notes ?? undefined,
      channel: info.channel === "github" ? "github" : "r2",
    },
  };
}

/** 按指定渠道下载并安装更新；成功后应用自动重启（安装器接管时进程直接被替换） */
export async function installUpdate(channel: UpdateChannel): Promise<void> {
  await invoke("install_app_update", { channel });
  await relaunch();
}
