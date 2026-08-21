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
  max_concurrent_downloads: number;  // 默认 1
  max_pages_per_video: number;       // 默认 2
  parallel_threads: number;          // 默认 4
  // 下载限速（KB/s，0 = 无限制）
  max_download_speed_kbps: number;   // 默认 0
  // 仅音频下载输出格式 "m4a" | "mp3"
  audio_format: string;              // 默认 "m4a"
  // 主题模式 "light" | "dark" | "system"
  theme: string;                     // 默认 "light"
  // 关闭窗口时最小化到系统托盘（后台继续下载）
  close_to_tray: boolean;            // 默认 true
  tray_hint_shown: boolean;          // 首次托盘提示是否已展示（前端只读）
  notify_on_complete: boolean;       // 默认 true

  // 防风控 - 设备指纹
  fingerprint_gpu_preset: string;
  fingerprint_resolution_preset: string;
  dm_img_str: string;
  dm_cover_img_str: string;
  dm_img_list: string;
  dm_img_inter: string;
  // 防风控 - 请求间隔
  request_delay_ms: number;
  // 附加下载 - 弹幕
  download_danmaku: boolean;
  // 附加下载 - 字幕
  download_subtitle: boolean;
  // 弹幕渲染 - 字号 / 滚动时长 / 透明度 / 屏蔽顶底
  danmaku_font_size: number;        // 小18 / 中25 / 大36
  danmaku_scroll_duration: number;  // 快8 / 标准15 / 慢25（秒，越大越慢）
  danmaku_opacity: number;          // 0.0-1.0（低0.2 / 中0.5 / 高0.8）
  danmaku_block_top: boolean;
  danmaku_block_bottom: boolean;
  // 历史弹幕：额外合并最近 N 天（0 = 关闭），下载 ASS 与播放器在线弹幕同时生效
  danmaku_history_days: number;
  // 字幕导出格式 "srt" | "vtt"
  subtitle_format: string;
  // 文件名模板：download_dir 下的相对路径，/ 分隔子目录。
  // 占位符 {title} {video_title} {bvid} {ep} {cid} {up}；空 = 默认 "{video_title}/{title}"（历史布局）
  filename_template: string;
  // 附加下载 - NFO 元数据刮削（生成 Kodi/Jellyfin/Emby 兼容 .nfo + 封面图）
  download_nfo: boolean;
  // NFO 详细选项 - 写入标签 <genre>（视频 tag / 番剧 style）
  nfo_include_genre: boolean;
  // NFO 详细选项 - 写入 UP 主信息 <actor>
  nfo_include_actor: boolean;
  // NFO 详细选项 - 写入播放统计 <tag>(播放量/点赞数)
  nfo_include_stats: boolean;
  // 订阅自动检查间隔（分钟，0 = 关闭自动追更）
  subscription_check_interval_min: number;
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
    max_concurrent_downloads: 1,
    max_pages_per_video: 2,
    parallel_threads: 4,
    max_download_speed_kbps: 0,
    audio_format: "m4a",
    theme: "light",
    close_to_tray: true,
    tray_hint_shown: false,
    notify_on_complete: true,
    fingerprint_gpu_preset: "",
    fingerprint_resolution_preset: "",
    dm_img_str: "",
    dm_cover_img_str: "",
    dm_img_list: "",
    dm_img_inter: "",
    request_delay_ms: 0,
    download_danmaku: false,
    download_subtitle: false,
    danmaku_font_size: 25,
    danmaku_scroll_duration: 15.0,
    danmaku_opacity: 0.3,
    danmaku_block_top: false,
    danmaku_block_bottom: false,
    danmaku_history_days: 0,
    subtitle_format: "srt",
    filename_template: "",
    download_nfo: false,
    nfo_include_genre: true,
    nfo_include_actor: true,
    nfo_include_stats: true,
    subscription_check_interval_min: 0,
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

  // 局部更新：patch 为 AppSettings 顶层字段子集，后端合并到磁盘当前值后返回完整设置。
  // 用于主题/auto_update 等单字段保存——前端若拿陈旧快照整份覆盖，
  // 会把设置页里未保存的修改静默回滚。
  const patch = useCallback(async (partial: Partial<AppSettings>) => {
    try {
      const merged = await invoke<AppSettings>("patch_settings", { patch: partial });
      setSettings(merged);
    } catch {
      // 合并失败保持现值；调用方按需 toast
    }
  }, []);

  return { settings, loading, save, patch };
}
