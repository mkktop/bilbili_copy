import { Download, Zap, Layers, Server, FileText, Sliders, GaugeCircle, Music, FolderTree, Bell } from "lucide-react";
import { SettingCard, SegmentedControl, ToggleRow, ToggleSwitch, NumberInput } from "./shared";

interface DownloadTabProps {
  maxConcurrentDownloads: number;
  onMaxConcurrentDownloadsChange: (v: number) => void;
  maxPagesPerVideo: number;
  onMaxPagesPerVideoChange: (v: number) => void;
  parallelThreads: number;
  onParallelThreadsChange: (v: number) => void;
  // 下载限速（KB/s，0 = 无限制）
  maxDownloadSpeedKbps: number;
  onMaxDownloadSpeedKbpsChange: (v: number) => void;
  // 仅音频输出格式
  audioFormat: string;
  onAudioFormatChange: (v: string) => void;
  // 文件名模板
  filenameTemplate: string;
  onFilenameTemplateChange: (v: string) => void;
  // NFO 元数据刮削
  downloadNfo: boolean;
  onDownloadNfoChange: (v: boolean) => void;
  nfoIncludeGenre: boolean;
  onNfoIncludeGenreChange: (v: boolean) => void;
  nfoIncludeActor: boolean;
  onNfoIncludeActorChange: (v: boolean) => void;
  nfoIncludeStats: boolean;
  onNfoIncludeStatsChange: (v: boolean) => void;
  // 订阅追更自动检查间隔（分钟，0 = 关闭）
  subscriptionIntervalMin: number;
  onSubscriptionIntervalMinChange: (v: number) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

const NUMBER_OPTIONS = [1, 2, 3, 4, 5];
const THREAD_OPTIONS = [1, 2, 4, 8];
const SUB_INTERVAL_OPTIONS = [0, 15, 30, 60, 180, 360];

export function DownloadTab({
  maxConcurrentDownloads,
  onMaxConcurrentDownloadsChange,
  maxPagesPerVideo,
  onMaxPagesPerVideoChange,
  parallelThreads,
  onParallelThreadsChange,
  maxDownloadSpeedKbps,
  onMaxDownloadSpeedKbpsChange,
  audioFormat,
  onAudioFormatChange,
  filenameTemplate,
  onFilenameTemplateChange,
  downloadNfo,
  onDownloadNfoChange,
  nfoIncludeGenre,
  onNfoIncludeGenreChange,
  nfoIncludeActor,
  onNfoIncludeActorChange,
  nfoIncludeStats,
  onNfoIncludeStatsChange,
  subscriptionIntervalMin,
  onSubscriptionIntervalMinChange,
  saving,
  saved,
  onSave,
}: DownloadTabProps) {
  // 模板实时预览（占位符替换为示例值，未知占位符置空——与后端渲染规则一致）
  const preview = (filenameTemplate.trim() || "{video_title}/{title}")
    .replace(/\{title\}/g, "视频标题")
    .replace(/\{video_title\}/g, "合集名")
    .replace(/\{bvid\}/g, "BV1xx411x7xx")
    .replace(/\{ep\}/g, "1234")
    .replace(/\{cid\}/g, "12345")
    .replace(/\{up\}/g, "UP主名")
    .replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "");
  return (
    <div className="space-y-4 max-w-lg">
      <SettingCard
        icon={Download}
        title="全局并发下载数"
        description="同时下载的最大任务数。增大可提高总吞吐量，但会占用更多带宽。"
      >
        <SegmentedControl
          options={NUMBER_OPTIONS.map((n) => ({ value: n, label: `${n}` }))}
          value={maxConcurrentDownloads}
          onChange={onMaxConcurrentDownloadsChange}
        />
      </SettingCard>

      <SettingCard
        icon={Layers}
        title="单视频分P并发数"
        description="同一视频最多同时下载几个分P。避免单视频占用过多下载通道。"
      >
        <SegmentedControl
          options={NUMBER_OPTIONS.map((n) => ({ value: n, label: `${n}` }))}
          value={maxPagesPerVideo}
          onChange={onMaxPagesPerVideoChange}
        />
      </SettingCard>

      <SettingCard
        icon={Zap}
        title="分片并行线程数"
        description="单个文件使用 Range 分片下载的线程数。文件 &ge;4MB 时生效，加速大文件下载。"
      >
        <SegmentedControl
          options={THREAD_OPTIONS.map((n) => ({
            value: n,
            label: n === 1 ? "关闭" : `${n} 线程`,
          }))}
          value={parallelThreads}
          onChange={onParallelThreadsChange}
        />
      </SettingCard>

      <SettingCard
        icon={GaugeCircle}
        title="下载限速"
        description="所有下载任务合计的速度上限，避免占满家庭带宽。设为「无限制」则不限速。"
      >
        <NumberInput
          value={maxDownloadSpeedKbps}
          onChange={onMaxDownloadSpeedKbpsChange}
          unit="KB/s"
          min={100}
          step={100}
          placeholder="如 1024"
        />
      </SettingCard>

      <SettingCard
        icon={Server}
        title="自动优化"
        description={
          <>
            <span className="text-ink-3">
              坏 CDN 节点自动缓存 10 分钟 &middot; 断点续传自动恢复 &middot; 并行失败自动降级单线程
            </span>
          </>
        }
      >
        <span className="text-xs text-green-600 font-medium">
          ✓ 已默认开启，无需手动配置
        </span>
      </SettingCard>

      {/* 仅音频下载 - 输出格式 */}
      <SettingCard
        icon={Music}
        title="仅音频输出格式"
        description="详情页勾选「仅下载音频」时的输出格式。m4a 为无损封装（保留原始 AAC），mp3 为转码（兼容老旧设备，有轻微音质损失）。"
      >
        <SegmentedControl
          options={[
            { value: "m4a", label: "M4A（无损）" },
            { value: "mp3", label: "MP3（转码）" },
          ]}
          value={audioFormat}
          onChange={onAudioFormatChange}
        />
      </SettingCard>

      {/* 文件名模板 */}
      <SettingCard
        icon={FolderTree}
        title="文件名模板"
        description="下载产物的保存路径与文件名（相对下载目录），/ 表示创建子目录。留空使用默认 {video_title}/{title}（即历史目录结构：每视频一个文件夹）。"
      >
        <input
          type="text"
          value={filenameTemplate}
          onChange={(e) => onFilenameTemplateChange(e.target.value)}
          placeholder="{video_title}/{title}"
          spellCheck={false}
          className="w-full px-3 py-2 text-sm font-mono border border-line-2 rounded-lg bg-panel-2 text-ink focus:outline-none focus:border-blue-500 transition-colors"
        />
        <p className="text-xs text-ink-3 mt-2 leading-relaxed">
          可用占位符：{"{title}"} 标题（多P时即 Pn 分P名）· {"{video_title}"} 合集/视频名 · {"{bvid}"} · {"{ep}"} 剧集号（非番剧为空，EP{"{ep}"} 会残留 EP 前缀）· {"{cid}"} · {"{up}"} UP 主名。
          非法字符与路径穿越自动清理，总路径过长时仅裁剪文件名段。
        </p>
        <p className="text-xs text-ink-2 mt-1.5 font-mono break-all">
          预览：{preview}.mp4
        </p>
      </SettingCard>

      {/* NFO 元数据刮削区块标题 */}
      <div className="pt-3">
        <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">元数据</h3>
      </div>

      <SettingCard
        icon={FileText}
        title="生成 NFO 元数据"
        description="视频下载完成后自动生成 Kodi / Jellyfin / Emby 兼容的 .nfo 文件，并下载封面图（-thumb.jpg / -fanart.jpg）到视频同目录，方便媒体库刮削入库。"
      >
        <ToggleSwitch checked={downloadNfo} onChange={onDownloadNfoChange} />
      </SettingCard>

      {downloadNfo && (
        <SettingCard
          icon={Sliders}
          title="NFO 详细选项"
          description="控制 .nfo 文件写入哪些字段。封面图不受此开关影响，开启 NFO 即下载。"
        >
          <div className="divide-y divide-line">
            <ToggleRow
              label="写入标签（<genre>）"
              checked={nfoIncludeGenre}
              onChange={onNfoIncludeGenreChange}
            />
            <ToggleRow
              label="写入 UP 主信息（<actor>）"
              checked={nfoIncludeActor}
              onChange={onNfoIncludeActorChange}
            />
            <ToggleRow
              label="写入播放统计（<tag> 播放量/点赞数）"
              checked={nfoIncludeStats}
              onChange={onNfoIncludeStatsChange}
            />
          </div>
          <p className="text-xs text-ink-3 mt-2">
            标签来自普通视频的 tag / 番剧的类型风格；恢复/重试下载时若缺少元数据将跳过 NFO 生成（不影响视频本身）。
          </p>
        </SettingCard>
      )}

      {/* 订阅追更 */}
      <SettingCard
        icon={Bell}
        title="订阅追更检查间隔"
        description="定时检查订阅的合集/收藏夹，发现新内容自动加入下载队列（已下载的自动跳过）。订阅入口在「我的 → 我的订阅 / 收藏夹 / UP 主合集」。"
      >
        <SegmentedControl
          options={SUB_INTERVAL_OPTIONS.map((n) => ({
            value: n,
            label: n === 0 ? "关闭" : n >= 60 ? `${n / 60}小时` : `${n}分钟`,
          }))}
          value={subscriptionIntervalMin}
          onChange={onSubscriptionIntervalMinChange}
        />
      </SettingCard>

      {/* Save button */}
      <button
        onClick={onSave}
        disabled={saving}
        className={
          "w-full py-2.5 rounded-lg text-sm font-medium transition-colors " +
          (saved
            ? "bg-green-500 text-white"
            : "bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50")
        }
      >
        {saving ? "保存中..." : saved ? "已保存 ✓" : "保存设置"}
      </button>
    </div>
  );
}
