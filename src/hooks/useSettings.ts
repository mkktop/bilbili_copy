import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  default_download_dir: string;
  auto_update: boolean;
  video_max_quality: number;    // 默认 127 (8K)
  video_min_quality: number;    // 默认 0 (不限制)
  audio_max_quality: number;    // 默认 30251 (Hi-Res 无损)
  audio_min_quality: number;    // 默认 0 (不限制)
  video_codec_priority: string[];  // 默认 ["AVC", "HEV", "AV1"]
  // 下载并发设置
  max_concurrent_downloads: number;  // 默认 2
  max_pages_per_video: number;       // 默认 2
  parallel_threads: number;          // 默认 4
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({
    default_download_dir: "",
    auto_update: false,
    video_max_quality: 127,
    video_min_quality: 0,
    audio_max_quality: 30251,
    audio_min_quality: 0,
    video_codec_priority: ["AVC", "HEV", "AV1"],
    max_concurrent_downloads: 2,
    max_pages_per_video: 2,
    parallel_threads: 4,
  });
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
