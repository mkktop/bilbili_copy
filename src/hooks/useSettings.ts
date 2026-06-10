import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  default_download_dir: string;
  auto_update: boolean;
  default_max_quality: number;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({ default_download_dir: "", auto_update: false, default_max_quality: 127 });
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
