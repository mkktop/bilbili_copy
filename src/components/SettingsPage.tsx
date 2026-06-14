import { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { GeneralTab } from "./settings/GeneralTab";
import { QualityTab } from "./settings/QualityTab";
import { DownloadTab } from "./settings/DownloadTab";
import { SubtitleTab } from "./settings/SubtitleTab";
import { AboutTab } from "./settings/AboutTab";
import { AntiRiskTab } from "./settings/AntiRiskTab";
import type { AppSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";

type Tab = "general" | "quality" | "download" | "subtitle" | "antirisk" | "about";

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onBack: () => void;
  onClearParse?: () => void;
  onClearDownload?: () => void;
}

export function SettingsPage({ settings, onSave, onBack, onClearParse, onClearDownload }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [dir, setDir] = useState(settings.default_download_dir);
  const [videoMaxQuality, setVideoMaxQuality] = useState(settings.video_max_quality);
  const [videoMinQuality, setVideoMinQuality] = useState(settings.video_min_quality);
  const [audioMaxQuality, setAudioMaxQuality] = useState(settings.audio_max_quality);
  const [audioMinQuality, setAudioMinQuality] = useState(settings.audio_min_quality);
  const [codecPriority, setCodecPriority] = useState<string[]>(settings.video_codec_priority);
  const [maxConcurrentDownloads, setMaxConcurrentDownloads] = useState(settings.max_concurrent_downloads);
  const [maxPagesPerVideo, setMaxPagesPerVideo] = useState(settings.max_pages_per_video);
  const [parallelThreads, setParallelThreads] = useState(settings.parallel_threads);
  // 防风控
  const [gpuPreset, setGpuPreset] = useState(settings.fingerprint_gpu_preset);
  const [resolutionPreset, setResolutionPreset] = useState(settings.fingerprint_resolution_preset);
  const [dmImgStr, setDmImgStr] = useState(settings.dm_img_str);
  const [dmCoverImgStr, setDmCoverImgStr] = useState(settings.dm_cover_img_str);
  const [dmImgList, setDmImgList] = useState(settings.dm_img_list);
  const [dmImgInter, setDmImgInter] = useState(settings.dm_img_inter);
  const [requestDelayMs, setRequestDelayMs] = useState(settings.request_delay_ms);
  const [downloadDanmaku, setDownloadDanmaku] = useState(settings.download_danmaku);
  const [downloadSubtitle, setDownloadSubtitle] = useState(settings.download_subtitle);
  // 弹幕渲染
  const [dmFontSize, setDmFontSize] = useState(settings.danmaku_font_size);
  const [dmScrollDuration, setDmScrollDuration] = useState(settings.danmaku_scroll_duration);
  const [dmOpacity, setDmOpacity] = useState(settings.danmaku_opacity);
  const [dmBlockTop, setDmBlockTop] = useState(settings.danmaku_block_top);
  const [dmBlockBottom, setDmBlockBottom] = useState(settings.danmaku_block_bottom);
  // 字幕格式
  const [subtitleFormat, setSubtitleFormat] = useState(settings.subtitle_format);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 当外部 settings 变化时同步本地状态
  useEffect(() => {
    setDir(settings.default_download_dir);
    setVideoMaxQuality(settings.video_max_quality);
    setVideoMinQuality(settings.video_min_quality);
    setAudioMaxQuality(settings.audio_max_quality);
    setAudioMinQuality(settings.audio_min_quality);
    setCodecPriority(settings.video_codec_priority);
    setMaxConcurrentDownloads(settings.max_concurrent_downloads);
    setMaxPagesPerVideo(settings.max_pages_per_video);
    setParallelThreads(settings.parallel_threads);
    setGpuPreset(settings.fingerprint_gpu_preset);
    setResolutionPreset(settings.fingerprint_resolution_preset);
    setDmImgStr(settings.dm_img_str);
    setDmCoverImgStr(settings.dm_cover_img_str);
    setDmImgList(settings.dm_img_list);
    setDmImgInter(settings.dm_img_inter);
    setRequestDelayMs(settings.request_delay_ms);
    setDownloadDanmaku(settings.download_danmaku);
    setDownloadSubtitle(settings.download_subtitle);
    setDmFontSize(settings.danmaku_font_size);
    setDmScrollDuration(settings.danmaku_scroll_duration);
    setDmOpacity(settings.danmaku_opacity);
    setDmBlockTop(settings.danmaku_block_top);
    setDmBlockBottom(settings.danmaku_block_bottom);
    setSubtitleFormat(settings.subtitle_format);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        default_download_dir: dir,
        auto_update: settings.auto_update,
        video_max_quality: videoMaxQuality,
        video_min_quality: videoMinQuality,
        audio_max_quality: audioMaxQuality,
        audio_min_quality: audioMinQuality,
        video_codec_priority: codecPriority,
        max_concurrent_downloads: maxConcurrentDownloads,
        max_pages_per_video: maxPagesPerVideo,
        parallel_threads: parallelThreads,
        fingerprint_gpu_preset: gpuPreset,
        fingerprint_resolution_preset: resolutionPreset,
        dm_img_str: dmImgStr,
        dm_cover_img_str: dmCoverImgStr,
        dm_img_list: dmImgList,
        dm_img_inter: dmImgInter,
        request_delay_ms: requestDelayMs,
        download_danmaku: downloadDanmaku,
        download_subtitle: downloadSubtitle,
        danmaku_font_size: dmFontSize,
        danmaku_scroll_duration: dmScrollDuration,
        danmaku_opacity: dmOpacity,
        danmaku_block_top: dmBlockTop,
        danmaku_block_bottom: dmBlockBottom,
        subtitle_format: subtitleFormat,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const tabLabels: Record<Tab, string> = {
    general: "通用",
    quality: "视频质量",
    download: "下载",
    subtitle: "字幕弹幕",
    antirisk: "防风控",
    about: "关于",
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">设置</h1>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 px-4">
        {(["general", "quality", "download", "subtitle", "antirisk", "about"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap",
              activeTab === tab
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            )}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {activeTab === "general" && (
          <GeneralTab
            dir={dir}
            onDirChange={(d) => { setDir(d); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
            onClearParse={onClearParse}
            onClearDownload={onClearDownload}
          />
        )}
        {activeTab === "quality" && (
          <QualityTab
            videoMaxQuality={videoMaxQuality}
            onVideoMaxQualityChange={(q) => { setVideoMaxQuality(q); setSaved(false); }}
            videoMinQuality={videoMinQuality}
            onVideoMinQualityChange={(q) => { setVideoMinQuality(q); setSaved(false); }}
            audioMaxQuality={audioMaxQuality}
            onAudioMaxQualityChange={(q) => { setAudioMaxQuality(q); setSaved(false); }}
            audioMinQuality={audioMinQuality}
            onAudioMinQualityChange={(q) => { setAudioMinQuality(q); setSaved(false); }}
            codecPriority={codecPriority}
            onCodecPriorityChange={(p) => { setCodecPriority(p); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
          />
        )}
        {activeTab === "download" && (
          <DownloadTab
            maxConcurrentDownloads={maxConcurrentDownloads}
            onMaxConcurrentDownloadsChange={(v) => { setMaxConcurrentDownloads(v); setSaved(false); }}
            maxPagesPerVideo={maxPagesPerVideo}
            onMaxPagesPerVideoChange={(v) => { setMaxPagesPerVideo(v); setSaved(false); }}
            parallelThreads={parallelThreads}
            onParallelThreadsChange={(v) => { setParallelThreads(v); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
          />
        )}
        {activeTab === "subtitle" && (
          <SubtitleTab
            downloadDanmaku={downloadDanmaku}
            onDownloadDanmakuChange={(v) => { setDownloadDanmaku(v); setSaved(false); }}
            dmFontSize={dmFontSize}
            onDmFontSizeChange={(v) => { setDmFontSize(v); setSaved(false); }}
            dmScrollDuration={dmScrollDuration}
            onDmScrollDurationChange={(v) => { setDmScrollDuration(v); setSaved(false); }}
            dmOpacity={dmOpacity}
            onDmOpacityChange={(v) => { setDmOpacity(v); setSaved(false); }}
            dmBlockTop={dmBlockTop}
            onDmBlockTopChange={(v) => { setDmBlockTop(v); setSaved(false); }}
            dmBlockBottom={dmBlockBottom}
            onDmBlockBottomChange={(v) => { setDmBlockBottom(v); setSaved(false); }}
            downloadSubtitle={downloadSubtitle}
            onDownloadSubtitleChange={(v) => { setDownloadSubtitle(v); setSaved(false); }}
            subtitleFormat={subtitleFormat}
            onSubtitleFormatChange={(v) => { setSubtitleFormat(v); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
          />
        )}
        {activeTab === "antirisk" && (
          <AntiRiskTab
            gpuPreset={gpuPreset}
            onGpuPresetChange={(v) => { setGpuPreset(v); setSaved(false); }}
            resolutionPreset={resolutionPreset}
            onResolutionPresetChange={(v) => { setResolutionPreset(v); setSaved(false); }}
            dmImgStr={dmImgStr}
            onDmImgStrChange={(v) => { setDmImgStr(v); setSaved(false); }}
            onDmCoverImgStrChange={(v) => { setDmCoverImgStr(v); setSaved(false); }}
            onDmImgListChange={(v) => { setDmImgList(v); setSaved(false); }}
            onDmImgInterChange={(v) => { setDmImgInter(v); setSaved(false); }}
            requestDelayMs={requestDelayMs}
            onRequestDelayMsChange={(v) => { setRequestDelayMs(v); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
          />
        )}
        {activeTab === "about" && (
          <AboutTab
            settings={settings}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  );
}
