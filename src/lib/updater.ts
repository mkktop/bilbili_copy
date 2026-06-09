import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "upToDate"
  | "error";

export interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
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

export async function checkForUpdate(): Promise<{
  available: boolean;
  info?: UpdateInfo;
  downloadAndInstall?: () => Promise<void>;
}> {
  const update = await check({ timeout: 30000 });

  if (update) {
    return {
      available: true,
      info: {
        version: update.version,
        date: update.date,
        body: update.body,
      },
      downloadAndInstall: async () => {
        // Save target version so next launch knows we just updated
        localStorage.setItem(JUST_UPDATED_KEY, update.version);
        await update.downloadAndInstall();
        await relaunch();
      },
    };
  }

  return { available: false };
}
