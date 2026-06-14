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
} from "lucide-react";
import type { DownloadTask } from "../types";
import { cn } from "../lib/utils";
import { HISTORY_PAGE_SIZE } from "../lib/constants";
import { Pagination } from "./Pagination";

interface DownloadListProps {
  downloads: DownloadTask[];
  onRemove: (id: string) => void;
  onPause: (id: string) => void;
  onCancel: (id: string) => void;
  onResume: (item: DownloadTask) => void;
  onRetry: (item: DownloadTask) => void;
  onSetPriority: (id: string, priority: number) => void;
  currentPage: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

const STATUS_CONFIG: Record<
  string,
  { icon: React.ReactNode; text: string; color: string }
> = {
  queued: {
    icon: <Clock size={14} />,
    text: "排队中",
    color: "text-gray-400",
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
          ? "text-gray-400 hover:text-red-500 hover:bg-red-50"
          : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
      )}
    >
      {children}
    </button>
  );
}

export function DownloadList({
  downloads,
  onRemove,
  onPause,
  onCancel,
  onResume,
  onRetry,
  onSetPriority,
  currentPage,
  totalCount,
  onPageChange,
}: DownloadListProps) {
  if (downloads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <Download size={40} strokeWidth={1.5} />
        <p className="text-sm">暂无下载任务</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {downloads.map((item) => {
        const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.downloading;
        // 进度条在 downloading（蓝，动）与 paused（琥珀，静态）时显示
        const showProgress =
          (item.status === "downloading" || item.status === "paused") &&
          item.progress !== undefined;

        return (
          <div
            key={item.id}
            className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg"
          >
            {/* 封面缩略图（无封面时回退文件图标） */}
            {item.pic ? (
              <img
                src={item.pic}
                alt={item.title}
                className="w-24 h-16 rounded object-cover shrink-0 bg-gray-100"
              />
            ) : (
              <div className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center shrink-0">
                <Download size={18} className="text-gray-400" />
              </div>
            )}

            {/* 信息区 */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
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
                      <span className="text-xs text-gray-400 ml-1">
                        {Math.round(item.progress)}%
                      </span>
                    )}
                  {item.errorMsg && (
                    <span className="text-xs text-red-400 ml-1 truncate">
                      {item.errorMsg}
                    </span>
                  )}
                </div>

                {/* 进度条 */}
                {showProgress && (
                  <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1.5">
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
                    onClick={() => onCancel(item.id)}
                    title="取消"
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
                    onClick={() => onCancel(item.id)}
                    title="取消（删除临时文件）"
                    danger
                  >
                    <X size={14} />
                  </IconButton>
                </>
              )}

              {item.status === "done" && (
                <IconButton onClick={() => onRemove(item.id)} title="删除" danger>
                  <X size={14} />
                </IconButton>
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
      })}

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
