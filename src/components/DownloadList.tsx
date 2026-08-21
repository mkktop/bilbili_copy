import { memo } from "react";
import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  Pause,
  Play,
  ChevronUp,
  RotateCw,
  Clock,
  FolderOpen,
  Trash2,
} from "lucide-react";
import type { DownloadTask } from "../types";
import { cn } from "../lib/utils";
import { HISTORY_PAGE_SIZE } from "../lib/constants";
import { Pagination } from "./Pagination";

interface DownloadListProps {
  downloads: DownloadTask[];
  /** 状态过滤（下载库标签页）；"done" 时按合集名分组展示 */
  filter?: string | null;
  onRemove: (id: string) => void;
  onRemoveWithFile: (item: DownloadTask) => void;
  onPause: (id: string) => void;
  onCancel: (id: string) => void;
  onResume: (item: DownloadTask) => void;
  onRetry: (item: DownloadTask) => void;
  onSetPriority: (id: string, priority: number) => void;
  onOpenFolder: (item: DownloadTask) => void;
  onOpenDetail: (item: DownloadTask) => void;
  currentPage: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

interface DownloadRowProps {
  item: DownloadTask;
  onRemove: (id: string) => void;
  onRemoveWithFile: (item: DownloadTask) => void;
  onPause: (id: string) => void;
  onCancel: (id: string) => void;
  onResume: (item: DownloadTask) => void;
  onRetry: (item: DownloadTask) => void;
  onSetPriority: (id: string, priority: number) => void;
  onOpenFolder: (item: DownloadTask) => void;
  onOpenDetail: (item: DownloadTask) => void;
}

const STATUS_CONFIG: Record<
  string,
  { icon: React.ReactNode; text: string; color: string }
> = {
  queued: {
    icon: <Clock size={14} />,
    text: "排队中",
    color: "text-ink-3",
  },
  downloading: {
    icon: <Loader2 size={14} className="animate-spin" />,
    text: "下载中",
    color: "text-blue-500",
  },
  paused: {
    icon: <Pause size={14} />,
    text: "已暂停",
    color: "text-amber-500",
  },
  done: {
    icon: <CheckCircle2 size={14} />,
    text: "完成",
    color: "text-green-500",
  },
  error: {
    icon: <XCircle size={14} />,
    text: "失败",
    color: "text-red-500",
  },
};

const PHASE_TEXT: Record<string, string> = {
  video: "下载视频中",
  audio: "下载音频中",
  merging: "合并中",
};

/** 速度格式化：B/s → KB/s → MB/s */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

/** 剩余时间估算：(total-downloaded)/speed → mm:ss / hh:mm:ss；数据不足返回空 */
function formatEta(item: DownloadTask): string {
  const { speed, downloadedBytes, totalBytes } = item;
  if (!speed || speed < 1024 || !totalBytes || !downloadedBytes) return "";
  const remaining = totalBytes - downloadedBytes;
  if (remaining <= 0) return "";
  const secs = Math.round(remaining / speed);
  if (secs < 1 || secs > 24 * 3600) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 小图标按钮（暂停/恢复/置顶/取消/重试/删除） */
function IconButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "p-1 rounded transition-colors shrink-0",
        danger
          ? "text-ink-3 hover:text-red-500 hover:bg-red-50"
          : "text-ink-3 hover:text-ink-2 hover:bg-panel-2"
      )}
    >
      {children}
    </button>
  );
}

/**
 * 单个下载任务行。
 * 用 memo 包裹 + 自定义比较：仅当 item 的渲染相关字段（status/progress/phase/...）
 * 变化时才重渲染该行。父组件 App 在下载进度节流后仍会重渲染，但只有真正变化的行
 * （如正在下载的那一行 progress 变了）会重绘，其余行跳过。
 * 回调函数 identity 不参与比较——这些回调行为恒定（调用 invoke + setState），
 * 忽略其引用变化可避免父组件未 useCallback 导致的 memo 失效。
 */
const DownloadRow = memo(
  function DownloadRow({
    item,
    onRemove,
    onRemoveWithFile,
    onPause,
    onCancel,
    onResume,
    onRetry,
    onSetPriority,
    onOpenFolder,
    onOpenDetail,
  }: DownloadRowProps) {
    const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.downloading;
    // 进度条在 downloading（蓝，动）与 paused（琥珀，静态）时显示
    const showProgress =
      (item.status === "downloading" || item.status === "paused") &&
      item.progress !== undefined;

    return (
      <div className="flex items-start gap-3 px-4 py-3 bg-panel border border-line rounded-lg">
        {/* 封面缩略图（无封面时回退文件图标）；点击进入视频详情页 */}
        {item.pic ? (
          <img
            src={item.pic}
            alt={item.title}
            title="查看详情"
            onClick={() => onOpenDetail(item)}
            className="w-24 h-16 rounded object-cover shrink-0 bg-panel-2 cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all"
          />
        ) : (
          <div
            title="查看详情"
            onClick={() => onOpenDetail(item)}
            className="w-24 h-16 rounded bg-panel-2 flex items-center justify-center shrink-0 cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all"
          >
            <Download size={18} className="text-ink-3" />
          </div>
        )}

        {/* 信息区 */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
            {item.title}
          </p>

          {/* 状态 + 进度 */}
          <div className="mt-1">
            <div className="flex items-center gap-1">
              <span className={cn("text-xs", status.color)}>
                {status.icon}
              </span>
              <span className={cn("text-xs", status.color)}>
                {item.status === "downloading" && item.phase
                  ? PHASE_TEXT[item.phase] || status.text
                  : status.text}
              </span>
              {(item.status === "downloading" || item.status === "paused") &&
                item.progress !== undefined && (
                  <span className="text-xs text-ink-3 ml-1">
                    {Math.round(item.progress)}%
                  </span>
                )}
              {item.status === "downloading" && item.speed && item.speed > 0 && (
                <span className="text-xs text-ink-3 ml-1">
                  {formatSpeed(item.speed)}
                  {formatEta(item) && ` · 剩余 ${formatEta(item)}`}
                </span>
              )}
              {item.status === "error" && item.errorMsg && (
                <span className="text-xs text-red-400 ml-1 truncate">
                  {item.errorMsg}
                </span>
              )}
            </div>

            {/* 进度条 */}
            {showProgress && (
              <div className="w-full bg-line rounded-full h-1.5 mt-1.5">
                <div
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    item.status === "paused"
                      ? "bg-amber-400"
                      : "bg-blue-500"
                  )}
                  style={{ width: `${Math.min(item.progress ?? 0, 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>

        {/* 操作按钮区：按状态切换 */}
        <div className="flex items-center gap-0.5 mt-1 shrink-0">
          {item.status === "queued" && (
            <>
              {/* 置顶：用一个大优先级值；后端 set_priority 会覆盖 */}
              <IconButton
                onClick={() => onSetPriority(item.id, 1000000)}
                title="置顶"
              >
                <ChevronUp size={14} />
              </IconButton>
              <IconButton
                onClick={() => onCancel(item.id)}
                title="取消"
                danger
              >
                <X size={14} />
              </IconButton>
            </>
          )}

          {item.status === "downloading" && (
            <>
              <IconButton onClick={() => onPause(item.id)} title="暂停">
                <Pause size={14} />
              </IconButton>
              <IconButton
                onClick={() => {
                  if (window.confirm(`确定取消「${item.title}」吗？已下载的临时文件将被删除。`)) {
                    onCancel(item.id);
                  }
                }}
                title="取消（删除临时文件）"
                danger
              >
                <X size={14} />
              </IconButton>
            </>
          )}

          {item.status === "paused" && (
            <>
              <IconButton onClick={() => onResume(item)} title="恢复">
                <Play size={14} />
              </IconButton>
              <IconButton
                onClick={() => {
                  if (window.confirm(`确定取消「${item.title}」吗？已下载的临时文件将被删除。`)) {
                    onCancel(item.id);
                  }
                }}
                title="取消（删除临时文件）"
                danger
              >
                <X size={14} />
              </IconButton>
            </>
          )}

          {item.status === "done" && (
            <>
              {item.outputPath && (
                <IconButton onClick={() => onOpenFolder(item)} title="打开所在目录">
                  <FolderOpen size={14} />
                </IconButton>
              )}
              {item.outputPath && (
                <IconButton onClick={() => onRemoveWithFile(item)} title="删除记录和文件" danger>
                  <Trash2 size={14} />
                </IconButton>
              )}
              <IconButton onClick={() => onRemove(item.id)} title="仅删除记录" danger>
                <X size={14} />
              </IconButton>
            </>
          )}

          {item.status === "error" && (
            <>
              <IconButton onClick={() => onRetry(item)} title="重试">
                <RotateCw size={14} />
              </IconButton>
              <IconButton onClick={() => onRemove(item.id)} title="删除" danger>
                <X size={14} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    // 仅比较影响渲染的 item 字段；回调 identity 不参与（行为恒定）。
    const a = prev.item;
    const b = next.item;
    return (
      a.status === b.status &&
      a.progress === b.progress &&
      a.phase === b.phase &&
      a.errorMsg === b.errorMsg &&
      a.outputPath === b.outputPath &&
      a.pic === b.pic &&
      a.title === b.title &&
      a.speed === b.speed &&
      a.downloadedBytes === b.downloadedBytes &&
      a.totalBytes === b.totalBytes
    );
  }
);

export function DownloadList({
  downloads,
  filter,
  onRemove,
  onRemoveWithFile,
  onPause,
  onCancel,
  onResume,
  onRetry,
  onSetPriority,
  onOpenFolder,
  onOpenDetail,
  currentPage,
  totalCount,
  onPageChange,
}: DownloadListProps) {
  if (downloads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-3 gap-2">
        <Download size={40} strokeWidth={1.5} />
        <p className="text-sm">暂无下载任务</p>
      </div>
    );
  }

  const renderRow = (item: DownloadTask) => (
    <DownloadRow
      key={item.id}
      item={item}
      onRemove={onRemove}
      onRemoveWithFile={onRemoveWithFile}
      onPause={onPause}
      onCancel={onCancel}
      onResume={onResume}
      onRetry={onRetry}
      onSetPriority={onSetPriority}
      onOpenFolder={onOpenFolder}
      onOpenDetail={onOpenDetail}
    />
  );

  // 已完成视图：按合集名（video_title）分组，散件（无合集名）归「单集」组
  if (filter === "done") {
    const groups: { name: string | null; items: DownloadTask[] }[] = [];
    for (const item of downloads) {
      const name = item.videoTitle?.trim() || null;
      const last = groups[groups.length - 1];
      if (last && last.name === name) {
        last.items.push(item);
      } else {
        groups.push({ name, items: [item] });
      }
    }
    return (
      <div className="space-y-4">
        {groups.map((g, i) => (
          <div key={i} className="space-y-2">
            {g.name && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-xs font-medium text-ink-2 truncate">{g.name}</span>
                <span className="text-[10px] text-ink-3 shrink-0">{g.items.length} 集</span>
                <div className="flex-1 h-px bg-line" />
              </div>
            )}
            {g.items.map(renderRow)}
          </div>
        ))}
        <Pagination
          currentPage={currentPage}
          totalCount={totalCount}
          pageSize={HISTORY_PAGE_SIZE}
          onPageChange={onPageChange}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {downloads.map(renderRow)}

      {/* 分页控件 */}
      <Pagination
        currentPage={currentPage}
        totalCount={totalCount}
        pageSize={HISTORY_PAGE_SIZE}
        onPageChange={onPageChange}
      />
    </div>
  );
}
