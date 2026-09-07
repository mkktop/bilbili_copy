import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { friendlyError } from "../lib/errors";
import {
  checkForUpdate,
  installUpdate,
  justUpdated,
  UPDATE_DOWNLOADED_EVENT,
  UPDATE_PROGRESS_EVENT,
  type UpdateChannel,
  type UpdaterPhase,
  type UpdateInfo,
  type UpdateProgress,
} from "../lib/updater";

interface UpdateContextValue {
  phase: UpdaterPhase;
  updateInfo: UpdateInfo | null;
  /** 下载进度（downloading 阶段有效；channel 为实际命中渠道） */
  progress: UpdateProgress | null;
  error: string | null;
  checkUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
  isDismissed: boolean;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

const DISMISSED_KEY = "bilibili_dl:update:dismissedVersion";

/** 读取更新渠道设置，异常时回退默认 R2 */
async function readUpdateChannel(): Promise<UpdateChannel> {
  try {
    const s = await invoke<{ update_channel?: string }>("get_settings");
    return s.update_channel === "github" ? "github" : "r2";
  } catch {
    return "r2";
  }
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const channelRef = useRef<UpdateChannel>("r2");

  // 下载进度 / 下载完成事件（后端 install_app_update 推送）
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (e) => {
      setProgress(e.payload);
    }).then((un) => unlisteners.push(un));
    listen<string>(UPDATE_DOWNLOADED_EVENT, () => {
      setPhase("installing");
    }).then((un) => unlisteners.push(un));
    return () => unlisteners.forEach((un) => un());
  }, []);

  // Auto-check on mount, gated by auto_update setting
  useEffect(() => {
    const timer = setTimeout(async () => {
      // Read auto_update setting directly (avoid provider nesting issues)
      try {
        const s = await invoke<{ auto_update: boolean }>("get_settings");
        if (!s.auto_update) return;
      } catch {
        // If settings read fails, proceed with check
      }

      const wasJustUpdated = await justUpdated();
      if (wasJustUpdated) {
        setPhase("upToDate");
        return;
      }
      checkUpdate();
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  const checkUpdate = useCallback(async () => {
    setPhase("checking");
    setError(null);
    channelRef.current = await readUpdateChannel();
    try {
      const result = await checkForUpdate(channelRef.current);
      if (result.available && result.info) {
        setUpdateInfo(result.info);
        setPhase("available");
        // Check if this version was dismissed
        const dismissed = localStorage.getItem(DISMISSED_KEY);
        setIsDismissed(dismissed === result.info.version);
      } else {
        setPhase("upToDate");
      }
    } catch (err) {
      setError(friendlyError(err));
      setPhase("error");
    }
  }, []);

  const install = useCallback(async () => {
    setProgress(null);
    setPhase("downloading");
    try {
      await installUpdate(channelRef.current);
      // install_app_update 成功后应用自行重启；走到 relaunch 说明后端未重启（防御）
      setPhase("installing");
    } catch (err) {
      setError(friendlyError(err));
      setPhase("error");
    }
  }, []);

  const dismiss = useCallback(() => {
    if (updateInfo) {
      localStorage.setItem(DISMISSED_KEY, updateInfo.version);
      setIsDismissed(true);
    }
    // Always reset phase so the popup closes
    setPhase("idle");
    setError(null);
  }, [updateInfo]);

  // value 用 useMemo 稳定 identity：只有 state/回调真正变化时才产生新对象，
  // 避免每次 Provider 重渲染（phase 切换等）都触发所有 useUpdate() 消费者重渲染。
  const value = useMemo<UpdateContextValue>(
    () => ({
      phase,
      updateInfo,
      progress,
      error,
      checkUpdate,
      installUpdate: install,
      dismiss,
      isDismissed,
    }),
    [phase, updateInfo, progress, error, isDismissed, checkUpdate, install, dismiss]
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate() {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within UpdateProvider");
  return ctx;
}
