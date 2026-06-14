import { Download, Zap, Layers, Server } from "lucide-react";
import { SettingCard, SegmentedControl } from "./shared";

interface DownloadTabProps {
  maxConcurrentDownloads: number;
  onMaxConcurrentDownloadsChange: (v: number) => void;
  maxPagesPerVideo: number;
  onMaxPagesPerVideoChange: (v: number) => void;
  parallelThreads: number;
  onParallelThreadsChange: (v: number) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

const NUMBER_OPTIONS = [1, 2, 3, 4, 5];
const THREAD_OPTIONS = [1, 2, 4, 8];

export function DownloadTab({
  maxConcurrentDownloads,
  onMaxConcurrentDownloadsChange,
  maxPagesPerVideo,
  onMaxPagesPerVideoChange,
  parallelThreads,
  onParallelThreadsChange,
  saving,
  saved,
  onSave,
}: DownloadTabProps) {
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
        icon={Server}
        title="自动优化"
        description={
          <>
            <span className="text-gray-500">
              坏 CDN 节点自动缓存 10 分钟 &middot; 断点续传自动恢复 &middot; 并行失败自动降级单线程
            </span>
          </>
        }
      >
        <span className="text-xs text-green-600 font-medium">
          ✓ 已默认开启，无需手动配置
        </span>
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
