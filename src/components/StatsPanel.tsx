import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Loader2, AlertCircle, Film, Database, Clock } from "lucide-react";
import type { DownloadStats } from "../types";
import { formatBytes, formatDurationHuman } from "../lib/utils";
import { friendlyError } from "../lib/errors";

interface Props {
  onBack: () => void;
}

/** 下载统计面板：累计下载视频数 / 总大小 / 总时长（仅累加已完成项）。 */
export function StatsPanel({ onBack }: Props) {
  const [stats, setStats] = useState<DownloadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<DownloadStats>("get_download_stats");
      setStats(data);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-line bg-panel">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">下载统计</h1>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-ink-3">
            <Loader2 size={20} className="animate-spin" />
            <span className="ml-2 text-sm">加载中…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-red-500">
            <AlertCircle size={24} />
            <p className="mt-2 text-sm">{error}</p>
            <button
              onClick={loadStats}
              className="mt-4 px-3 py-1.5 text-xs text-ink-2 border border-line-2 rounded-lg hover:bg-panel-2 transition-colors"
            >
              重试
            </button>
          </div>
        ) : stats && stats.done_count === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-ink-3">
            <Film size={28} />
            <p className="mt-2 text-sm">还没有已完成的下载</p>
            <p className="mt-1 text-xs text-ink-3">
              {stats.total_count > 0
                ? `当前有 ${stats.total_count} 个下载记录，完成下载后将在此展示统计`
                : "下载第一个视频后，这里会展示累计统计"}
            </p>
          </div>
        ) : stats ? (
          <>
            <header className="mb-4">
              <h2 className="text-sm font-medium text-ink-2">累计下载</h2>
              <p className="text-xs text-ink-3 mt-0.5">仅统计已完成的下载</p>
            </header>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                icon={Film}
                label="已完成视频"
                value={String(stats.done_count)}
                sub={`共 ${stats.total_count} 个记录`}
              />
              <StatCard
                icon={Database}
                label="总大小"
                value={formatBytes(stats.done_size)}
              />
              <StatCard
                icon={Clock}
                label="总时长"
                value={formatDurationHuman(stats.done_duration)}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 单张统计卡：图标 + 标签 + 大数字 + 副标。 */
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="p-5 rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 text-ink-3">
        <Icon size={16} />
        <span className="text-xs">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-ink tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-ink-3">{sub}</div> : null}
    </div>
  );
}
