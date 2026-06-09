import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  Clock,
  User,
  Layers,
  Play,
} from "lucide-react";
import type { DownloadEntry } from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";

interface DownloadListProps {
  downloads: DownloadEntry[];
  onRemove: (id: string) => void;
  onDownload: (id: string, bvid: string, cid: number, title: string) => void;
}

const STATUS_CONFIG: Record<
  string,
  { icon: React.ReactNode; text: string; color: string }
> = {
  pending: {
    icon: <Download size={14} />,
    text: "等待下载",
    color: "text-gray-400",
  },
  parsing: {
    icon: <Loader2 size={14} className="animate-spin" />,
    text: "解析中",
    color: "text-blue-500",
  },
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

export function DownloadList({ downloads, onRemove, onDownload }: DownloadListProps) {
  if (downloads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <Download size={40} strokeWidth={1.5} />
        <p className="text-sm">输入视频链接开始下载</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {downloads.map((item) => {
        const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending;
        const info = item.videoInfo;

        return (
          <div
            key={item.id}
            className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg"
          >
            {/* 封面缩略图 */}
            {info?.pic ? (
              <img
                src={info.pic}
                alt={info.title}
                className="w-24 h-16 rounded object-cover shrink-0 bg-gray-100"
              />
            ) : (
              <div className="w-24 h-16 rounded bg-gray-100 flex items-center justify-center shrink-0">
                <Download size={20} className="text-gray-300" />
              </div>
            )}

            {/* 信息区 */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
                {item.title}
              </p>

              {/* 元信息行 */}
              {info && (
                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                  {info.owner_name && (
                    <span className="flex items-center gap-0.5">
                      <User size={10} />
                      {info.owner_name}
                    </span>
                  )}
                  {info.duration > 0 && (
                    <span className="flex items-center gap-0.5">
                      <Clock size={10} />
                      {formatDuration(info.duration)}
                    </span>
                  )}
                  {info.pages.length > 1 && (
                    <span className="flex items-center gap-0.5">
                      <Layers size={10} />
                      {info.pages.length}P
                    </span>
                  )}
                </div>
              )}

              {/* 状态 + 进度条 */}
              <div className="mt-1">
                <div className="flex items-center gap-1">
                  <span className={cn("text-xs", status.color)}>
                    {status.icon}
                  </span>
                  <span className={cn("text-xs", status.color)}>
                    {status.text}
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

            {/* 操作按钮 */}
            <div className="flex items-center gap-1 shrink-0 mt-1">
              {/* 下载按钮：pending状态显示 */}
              {item.status === "pending" && info && (
                <button
                  onClick={() => {
                    const page = info.pages[0];
                    onDownload(item.id, info.bvid, page.cid, info.title);
                  }}
                  className="p-1.5 rounded text-blue-500 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                  title="下载"
                >
                  <Play size={14} />
                </button>
              )}

              {/* 删除按钮 */}
              <button
                onClick={() => onRemove(item.id)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
