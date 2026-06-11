import { Download, Zap, Layers, Server } from "lucide-react";
import { cn } from "../../lib/utils";

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

function SettingCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl border border-gray-100 bg-white">
      <div className="p-2 rounded-lg bg-blue-50 text-blue-500 mt-0.5">
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-gray-800">{title}</h3>
        <p className="text-xs text-gray-400 mt-0.5">{description}</p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
            value === opt.value
              ? "bg-white text-blue-600 shadow-sm border border-gray-200"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

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
        className={cn(
          "w-full py-2.5 rounded-lg text-sm font-medium transition-colors",
          saved
            ? "bg-green-500 text-white"
            : "bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
        )}
      >
        {saving ? "保存中..." : saved ? "已保存 ✓" : "保存设置"}
      </button>
    </div>
  );
}
