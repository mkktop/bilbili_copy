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
import { friendlyError } from "../lib/errors";
import {
  checkForUpdate,
  justUpdated,
  type UpdaterPhase,
  type UpdateInfo,
} from "../lib/updater";

interface UpdateContextValue {
  phase: UpdaterPhase;
  updateInfo: UpdateInfo | null;
  error: string | null;
  checkUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
  isDismissed: boolean;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

const DISMISSED_KEY = "bilibili_dl:update:dismissedVersion";

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const installerRef = useRef<(() => Promise<void>) | null>(null);

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
    try {
      const result = await checkForUpdate();
      if (result.available && result.info) {
        setUpdateInfo(result.info);
        setPhase("available");
        // Check if this version was dismissed
        const dismissed = localStorage.getItem(DISMISSED_KEY);
        setIsDismissed(dismissed === result.info.version);
        // Store downloadAndInstall for later use
        installerRef.current = result.downloadAndInstall ?? null;
      } else {
        setPhase("upToDate");
      }
    } catch (err) {
      setError(friendlyError(err));
      setPhase("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const installer = installerRef.current;
    if (!installer) return;

    setPhase("downloading");
    try {
      await installer();
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
      error,
      checkUpdate,
      installUpdate,
      dismiss,
      isDismissed,
    }),
    [phase, updateInfo, error, isDismissed, checkUpdate, installUpdate, dismiss]
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
