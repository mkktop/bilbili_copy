import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, Save, Loader2, SlidersHorizontal, MonitorPlay, FolderDown, Subtitles, ShieldCheck, Plug, Info } from "lucide-react";
import { GeneralTab } from "./settings/GeneralTab";
import { QualityTab } from "./settings/QualityTab";
import { DownloadTab } from "./settings/DownloadTab";
import { SubtitleTab } from "./settings/SubtitleTab";
import { AboutTab } from "./settings/AboutTab";
import { AntiRiskTab } from "./settings/AntiRiskTab";
import { McpTab } from "./settings/McpTab";
import type { AppSettings } from "../hooks/useSettings";

type Tab = "general" | "quality" | "download" | "subtitle" | "antirisk" | "mcp" | "about";

interface SettingsPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  /** 单字段局部保存（走后端 patch_settings，不整份覆盖） */
  onPatch?: (partial: Partial<AppSettings>) => Promise<void>;
  onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onClearParse?: () => void;
  onClearDownload?: () => void;
}

export function SettingsPage({ settings, onSave, onPatch, onBack, onClearParse, onClearDownload, onDirtyChange }: SettingsPageProps) {
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
  const [dmHistoryDays, setDmHistoryDays] = useState(settings.danmaku_history_days);
  // 字幕格式
  const [subtitleFormat, setSubtitleFormat] = useState(settings.subtitle_format);
  // 文件名模板
  const [filenameTemplate, setFilenameTemplate] = useState(settings.filename_template);
  // NFO 元数据刮削
  const [downloadNfo, setDownloadNfo] = useState(settings.download_nfo);
  const [nfoIncludeGenre, setNfoIncludeGenre] = useState(settings.nfo_include_genre);
  const [nfoIncludeActor, setNfoIncludeActor] = useState(settings.nfo_include_actor);
  const [nfoIncludeStats, setNfoIncludeStats] = useState(settings.nfo_include_stats);
  // 订阅追更检查间隔（分钟，0 = 关闭）
  const [subInterval, setSubInterval] = useState(settings.subscription_check_interval_min);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const previousSettings = useRef(settings);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  // 仅同步真正被外部修改的字段。主题/MCP 即时保存不能清空其它未保存输入。
  useEffect(() => {
    const previous = previousSettings.current;
    if (JSON.stringify(previous.default_download_dir) !== JSON.stringify(settings.default_download_dir)) setDir(settings.default_download_dir);
    if (JSON.stringify(previous.video_max_quality) !== JSON.stringify(settings.video_max_quality)) setVideoMaxQuality(settings.video_max_quality);
    if (JSON.stringify(previous.video_min_quality) !== JSON.stringify(settings.video_min_quality)) setVideoMinQuality(settings.video_min_quality);
    if (JSON.stringify(previous.audio_max_quality) !== JSON.stringify(settings.audio_max_quality)) setAudioMaxQuality(settings.audio_max_quality);
    if (JSON.stringify(previous.audio_min_quality) !== JSON.stringify(settings.audio_min_quality)) setAudioMinQuality(settings.audio_min_quality);
    if (JSON.stringify(previous.video_codec_priority) !== JSON.stringify(settings.video_codec_priority)) setCodecPriority(settings.video_codec_priority);
    if (JSON.stringify(previous.max_concurrent_downloads) !== JSON.stringify(settings.max_concurrent_downloads)) setMaxConcurrentDownloads(settings.max_concurrent_downloads);
    if (JSON.stringify(previous.max_pages_per_video) !== JSON.stringify(settings.max_pages_per_video)) setMaxPagesPerVideo(settings.max_pages_per_video);
    if (JSON.stringify(previous.parallel_threads) !== JSON.stringify(settings.parallel_threads)) setParallelThreads(settings.parallel_threads);
    if (JSON.stringify(previous.max_download_speed_kbps) !== JSON.stringify(settings.max_download_speed_kbps)) setMaxDownloadSpeedKbps(settings.max_download_speed_kbps);
    if (JSON.stringify(previous.audio_format) !== JSON.stringify(settings.audio_format)) setAudioFormat(settings.audio_format);
    if (JSON.stringify(previous.close_to_tray) !== JSON.stringify(settings.close_to_tray)) setCloseToTray(settings.close_to_tray);
    if (JSON.stringify(previous.notify_on_complete) !== JSON.stringify(settings.notify_on_complete)) setNotifyOnComplete(settings.notify_on_complete);
    if (JSON.stringify(previous.fingerprint_gpu_preset) !== JSON.stringify(settings.fingerprint_gpu_preset)) setGpuPreset(settings.fingerprint_gpu_preset);
    if (JSON.stringify(previous.fingerprint_resolution_preset) !== JSON.stringify(settings.fingerprint_resolution_preset)) setResolutionPreset(settings.fingerprint_resolution_preset);
    if (JSON.stringify(previous.dm_img_str) !== JSON.stringify(settings.dm_img_str)) setDmImgStr(settings.dm_img_str);
    if (JSON.stringify(previous.dm_cover_img_str) !== JSON.stringify(settings.dm_cover_img_str)) setDmCoverImgStr(settings.dm_cover_img_str);
    if (JSON.stringify(previous.dm_img_list) !== JSON.stringify(settings.dm_img_list)) setDmImgList(settings.dm_img_list);
    if (JSON.stringify(previous.dm_img_inter) !== JSON.stringify(settings.dm_img_inter)) setDmImgInter(settings.dm_img_inter);
    if (JSON.stringify(previous.request_delay_ms) !== JSON.stringify(settings.request_delay_ms)) setRequestDelayMs(settings.request_delay_ms);
    if (JSON.stringify(previous.download_danmaku) !== JSON.stringify(settings.download_danmaku)) setDownloadDanmaku(settings.download_danmaku);
    if (JSON.stringify(previous.download_subtitle) !== JSON.stringify(settings.download_subtitle)) setDownloadSubtitle(settings.download_subtitle);
    if (JSON.stringify(previous.danmaku_font_size) !== JSON.stringify(settings.danmaku_font_size)) setDmFontSize(settings.danmaku_font_size);
    if (JSON.stringify(previous.danmaku_scroll_duration) !== JSON.stringify(settings.danmaku_scroll_duration)) setDmScrollDuration(settings.danmaku_scroll_duration);
    if (JSON.stringify(previous.danmaku_opacity) !== JSON.stringify(settings.danmaku_opacity)) setDmOpacity(settings.danmaku_opacity);
    if (JSON.stringify(previous.danmaku_block_top) !== JSON.stringify(settings.danmaku_block_top)) setDmBlockTop(settings.danmaku_block_top);
    if (JSON.stringify(previous.danmaku_block_bottom) !== JSON.stringify(settings.danmaku_block_bottom)) setDmBlockBottom(settings.danmaku_block_bottom);
    if (JSON.stringify(previous.danmaku_history_days) !== JSON.stringify(settings.danmaku_history_days)) setDmHistoryDays(settings.danmaku_history_days);
    if (JSON.stringify(previous.subtitle_format) !== JSON.stringify(settings.subtitle_format)) setSubtitleFormat(settings.subtitle_format);
    if (JSON.stringify(previous.filename_template) !== JSON.stringify(settings.filename_template)) setFilenameTemplate(settings.filename_template);
    if (JSON.stringify(previous.download_nfo) !== JSON.stringify(settings.download_nfo)) setDownloadNfo(settings.download_nfo);
    if (JSON.stringify(previous.nfo_include_genre) !== JSON.stringify(settings.nfo_include_genre)) setNfoIncludeGenre(settings.nfo_include_genre);
    if (JSON.stringify(previous.nfo_include_actor) !== JSON.stringify(settings.nfo_include_actor)) setNfoIncludeActor(settings.nfo_include_actor);
    if (JSON.stringify(previous.nfo_include_stats) !== JSON.stringify(settings.nfo_include_stats)) setNfoIncludeStats(settings.nfo_include_stats);
    if (JSON.stringify(previous.subscription_check_interval_min) !== JSON.stringify(settings.subscription_check_interval_min)) setSubInterval(settings.subscription_check_interval_min);
    previousSettings.current = settings;
  }, [settings]);

  const draft: AppSettings = {
    ...settings,
    default_download_dir: dir,
    close_to_tray: closeToTray,
    notify_on_complete: notifyOnComplete,
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
    danmaku_history_days: dmHistoryDays,
    subtitle_format: subtitleFormat,
    filename_template: filenameTemplate,
    download_nfo: downloadNfo,
    nfo_include_genre: nfoIncludeGenre,
    nfo_include_actor: nfoIncludeActor,
    nfo_include_stats: nfoIncludeStats,
    subscription_check_interval_min: subInterval,
  };
  const dirty = Object.entries(draft).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(settings[key as keyof AppSettings]));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true); setSaveError("");
    try {
      await onSave(draft);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      // 保存失败必须可见：否则用户以为已保存，重启后设置丢失
      setSaveError(`保存设置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { key: "general", label: "通用设置", description: "外观、保存位置与窗口行为", Icon: SlidersHorizontal },
    { key: "quality", label: "画质与编码", description: "选择下载的视频与音频质量", Icon: MonitorPlay },
    { key: "download", label: "下载与文件", description: "并发、速度、命名与订阅", Icon: FolderDown },
    { key: "subtitle", label: "字幕与弹幕", description: "附加内容、导出格式与渲染样式", Icon: Subtitles },
    { key: "antirisk", label: "网络与验证", description: "请求间隔与设备信息", Icon: ShieldCheck },
    { key: "mcp", label: "AI 工具连接", description: "连接支持 MCP 的 AI 客户端", Icon: Plug },
    { key: "about", label: "关于与更新", description: "版本信息与应用更新", Icon: Info },
  ] as const;
  const selectedTab = tabs.find(tab => tab.key === activeTab)!;

  return (
    <div className="settings-page">
      <header className="workspace-header flex items-center gap-3">
        <button type="button" aria-label="返回工作台" onClick={onBack} className="p-1.5 rounded-lg border border-line hover:bg-panel-2"><ArrowLeft size={16} /></button>
        <h1 className="text-lg font-semibold text-ink">设置</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置分类"><p>偏好设置</p>{tabs.map((tab, index) => <div key={tab.key}>
          {index === 4 && <p className="px-3 pt-5 pb-3 text-[10px] text-ink-3">高级与应用</p>}
          <button type="button" aria-current={activeTab === tab.key ? "page" : undefined} onClick={() => setActiveTab(tab.key)}><tab.Icon size={16} />{tab.label}</button>
        </div>)}</nav>
        <div className="settings-main">
          <div className="settings-content">
            <div className="settings-section-heading"><h2>{selectedTab.label}</h2><p>{selectedTab.description}</p></div>
            <fieldset disabled={saving}>
        {activeTab === "general" && (
          <GeneralTab
            dir={dir}
            onDirChange={(d) => { setDir(d); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
            showSaveButton={false}
            onClearParse={onClearParse}
            onClearDownload={onClearDownload}
            theme={settings.theme}
            onThemeChange={(t) => {
              // 局部保存主题：整份覆盖会把本页未保存的其它修改一起落盘（旧值回滚）
              void (onPatch ? onPatch({ theme: t }) : onSave({ ...settings, theme: t })).catch(error => setSaveError(`主题保存失败：${String(error)}`));
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
            showSaveButton={false}
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
            subscriptionIntervalMin={subInterval}
            onSubscriptionIntervalMinChange={(v) => { setSubInterval(v); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
            showSaveButton={false}
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
            dmHistoryDays={dmHistoryDays}
            onDmHistoryDaysChange={(v) => { setDmHistoryDays(v); setSaved(false); }}
            downloadSubtitle={downloadSubtitle}
            onDownloadSubtitleChange={(v) => { setDownloadSubtitle(v); setSaved(false); }}
            subtitleFormat={subtitleFormat}
            onSubtitleFormatChange={(v) => { setSubtitleFormat(v); setSaved(false); }}
            saving={saving}
            saved={saved}
            onSave={handleSave}
            showSaveButton={false}
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
            showSaveButton={false}
          />
        )}
        {activeTab === "mcp" && (
          <McpTab
            settings={settings}
            onSave={onSave}
            onPatch={onPatch}
          />
        )}
        {activeTab === "about" && (
          <AboutTab
            settings={settings}
            onSave={onSave}
            onPatch={onPatch}
          />
        )}
            </fieldset>
          </div>
          {(activeTab !== "mcp" && activeTab !== "about" || dirty) && <footer className="settings-footer">
            <span role={saveError ? "alert" : "status"} className={saveError ? "text-red-500" : ""}>{saveError || (saving ? "正在保存设置…" : dirty ? "有尚未保存的修改" : saved ? "设置已保存" : "所有设置已保存")}</span>
            <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty}>{saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <Check size={15} /> : <Save size={15} />}{saving ? "保存中" : "保存修改"}</button>
          </footer>}
        </div>
      </div>
    </div>
  );
}
