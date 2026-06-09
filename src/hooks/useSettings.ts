import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  default_download_dir: string;
  auto_update: boolean;
  ffmpeg_path: string;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({ default_download_dir: "", auto_update: false, ffmpeg_path: "" });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await invoke<AppSettings>("get_settings");
      setSettings(s);
    } catch {
      // use defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (updated: AppSettings) => {
    await invoke("save_settings", { settings: updated });
    setSettings(updated);
  }, []);

  return { settings, loading, save };
}
