import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
} from "lucide-react";
import type { DownloadTask } from "../types";
import { cn } from "../lib/utils";

interface DownloadListProps {
  downloads: DownloadTask[];
  onRemove: (id: string) => void;
}

const STATUS_CONFIG: Record<
  string,
  { icon: React.ReactNode; text: string; color: string }
> = {
  downloading: {
    icon: <Loader2 size={14} className="animate-spin" />,
    text: "下载中",
    color: "text-blue-500",
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

export function DownloadList({ downloads, onRemove }: DownloadListProps) {
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

        return (
          <div
            key={item.id}
            className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg"
          >
            {/* 文件图标 */}
            <div className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center shrink-0">
              <Download size={18} className="text-gray-400" />
            </div>

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
                  {item.status === "downloading" && item.progress !== undefined && (
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
                {item.status === "downloading" && item.progress !== undefined && (
                  <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(item.progress, 100)}%` }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* 删除 */}
            <button
              onClick={() => onRemove(item.id)}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0 mt-1"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
