import { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { GeneralTab } from "./settings/GeneralTab";
import { QualityTab } from "./settings/QualityTab";
import { DownloadTab } from "./settings/DownloadTab";
import { AboutTab } from "./settings/AboutTab";
import type { AppSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";

type Tab = "general" | "quality" | "download" | "about";

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
      <div className="flex border-b border-gray-200 px-6">
        {(["general", "quality", "download", "about"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
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
