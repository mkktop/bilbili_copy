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
  /** 单字段局部保存（走后端 patch_settings，不整份覆盖） */
  onPatch?: (partial: Partial<AppSettings>) => Promise<void>;
  onBack: () => void;
  onClearParse?: () => void;
  onClearDownload?: () => void;
}

export function SettingsPage({ settings, onSave, onPatch, onBack, onClearParse, onClearDownload }: SettingsPageProps) {
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
  const [maxDownloadSpeedKbps, setMaxDownloadSpeedKbps] = useState(settings.max_download_speed_kbps);
  const [audioFormat, setAudioFormat] = useState(settings.audio_format);
  const [closeToTray, setCloseToTray] = useState(settings.close_to_tray);
  const [notifyOnComplete, setNotifyOnComplete] = useState(settings.notify_on_complete);
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
  // 文件名模板
  const [filenameTemplate, setFilenameTemplate] = useState(settings.filename_template);
  // NFO 元数据刮削
  const [downloadNfo, setDownloadNfo] = useState(settings.download_nfo);
  const [nfoIncludeGenre, setNfoIncludeGenre] = useState(settings.nfo_include_genre);
  const [nfoIncludeActor, setNfoIncludeActor] = useState(settings.nfo_include_actor);
  const [nfoIncludeStats, setNfoIncludeStats] = useState(settings.nfo_include_stats);
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
    setMaxDownloadSpeedKbps(settings.max_download_speed_kbps);
    setAudioFormat(settings.audio_format);
    setCloseToTray(settings.close_to_tray);
    setNotifyOnComplete(settings.notify_on_complete);
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
    setFilenameTemplate(settings.filename_template);
    setDownloadNfo(settings.download_nfo);
    setNfoIncludeGenre(settings.nfo_include_genre);
    setNfoIncludeActor(settings.nfo_include_actor);
    setNfoIncludeStats(settings.nfo_include_stats);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        default_download_dir: dir,
        auto_update: settings.auto_update,
        theme: settings.theme,
        close_to_tray: closeToTray,
        notify_on_complete: notifyOnComplete,
        tray_hint_shown: settings.tray_hint_shown,
        video_max_quality: videoMaxQuality,
        video_min_quality: videoMinQuality,
        audio_max_quality: audioMaxQuality,
        audio_min_quality: audioMinQuality,
        video_codec_priority: codecPriority,
        max_concurrent_downloads: maxConcurrentDownloads,
        max_pages_per_video: maxPagesPerVideo,
        parallel_threads: parallelThreads,
        max_download_speed_kbps: maxDownloadSpeedKbps,
        audio_format: audioFormat,
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
        filename_template: filenameTemplate,
        download_nfo: downloadNfo,
        nfo_include_genre: nfoIncludeGenre,
        nfo_include_actor: nfoIncludeActor,
        nfo_include_stats: nfoIncludeStats,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      // 保存失败必须可见：否则用户以为已保存，重启后设置丢失
      console.error(e);
      window.alert(`保存设置失败：${e instanceof Error ? e.message : String(e)}`);
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
      <div className="flex items-center gap-3 px-6 py-4 border-b border-line">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">设置</h1>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-line px-4">
        {(["general", "quality", "download", "subtitle", "antirisk", "about"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap",
              activeTab === tab
                ? "border-blue-500 text-accent"
                : "border-transparent text-ink-3 hover:text-ink-2"
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
            theme={settings.theme}
            onThemeChange={(t) => {
              // 局部保存主题：整份覆盖会把本页未保存的其它修改一起落盘（旧值回滚）
              void (onPatch ? onPatch({ theme: t }) : onSave({ ...settings, theme: t }));
            }}
            closeToTray={closeToTray}
            onCloseToTrayChange={(v) => { setCloseToTray(v); setSaved(false); }}
            notifyOnComplete={notifyOnComplete}
            onNotifyOnCompleteChange={(v) => { setNotifyOnComplete(v); setSaved(false); }}
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
            maxDownloadSpeedKbps={maxDownloadSpeedKbps}
            onMaxDownloadSpeedKbpsChange={(v) => { setMaxDownloadSpeedKbps(v); setSaved(false); }}
            audioFormat={audioFormat}
            onAudioFormatChange={(v) => { setAudioFormat(v); setSaved(false); }}
            filenameTemplate={filenameTemplate}
            onFilenameTemplateChange={(v) => { setFilenameTemplate(v); setSaved(false); }}
            downloadNfo={downloadNfo}
            onDownloadNfoChange={(v) => { setDownloadNfo(v); setSaved(false); }}
            nfoIncludeGenre={nfoIncludeGenre}
            onNfoIncludeGenreChange={(v) => { setNfoIncludeGenre(v); setSaved(false); }}
            nfoIncludeActor={nfoIncludeActor}
            onNfoIncludeActorChange={(v) => { setNfoIncludeActor(v); setSaved(false); }}
            nfoIncludeStats={nfoIncludeStats}
            onNfoIncludeStatsChange={(v) => { setNfoIncludeStats(v); setSaved(false); }}
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
            onPatch={onPatch}
          />
        )}
      </div>
    </div>
  );
}
