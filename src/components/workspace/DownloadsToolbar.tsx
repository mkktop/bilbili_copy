import { Pause, RotateCw, RefreshCw } from "lucide-react";
import type { DownloadFilter, LibraryCounts } from "../../hooks/useLibraryOverview";

export function DownloadsToolbar({ filter, counts, onFilter, onPauseAll, onRetryFailed, onRefresh, hasFailedTasks }: {
  filter: string | null; counts: LibraryCounts | null; onFilter: (status: DownloadFilter) => void;
  onPauseAll: () => void; onRetryFailed: () => void; onRefresh: () => void; hasFailedTasks: boolean;
}) {
  const items: [DownloadFilter, string][] = [[null, "全部任务"], ["downloading", "下载中"], ["queued", "排队中"], ["paused", "已暂停"], ["done", "已完成"], ["error", "失败"]];
  return <>
    <header className="workspace-page-heading downloads-heading"><div><span className="workspace-eyebrow">内容管理</span><h1>下载管理</h1><p>{counts ? `${counts.all} 个任务 · ${counts.downloading} 个下载中 · ${counts.queued} 个排队中` : "查看任务进度，管理已保存的内容"}</p></div><div className="workspace-actions">
      {counts && counts.downloading + counts.queued > 0 && <button type="button" onClick={onPauseAll}><Pause size={15} />全部暂停</button>}
      {hasFailedTasks && <button type="button" onClick={onRetryFailed}><RotateCw size={15} />重试本页失败任务</button>}
      <button type="button" onClick={onRefresh} aria-label="刷新下载列表" title="刷新下载列表"><RefreshCw size={16} /></button>
    </div></header>
    <nav className="workspace-tabs download-tabs" aria-label="下载状态筛选">{items.map(([status, label]) => <button type="button" key={label} aria-current={filter === status ? "page" : undefined} onClick={() => onFilter(status)}>{label}<span>{counts?.[status ?? "all"] ?? "—"}</span></button>)}</nav>
  </>;
}
