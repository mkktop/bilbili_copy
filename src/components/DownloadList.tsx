import { Download, Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import type { DownloadEntry } from "../types";
import { cn } from "../lib/utils";

interface DownloadListProps {
  downloads: DownloadEntry[];
  onRemove: (id: string) => void;
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; text: string; color: string }> = {
  pending: {
    icon: <Download size={14} />,
    text: "等待中",
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

export function DownloadList({ downloads, onRemove }: DownloadListProps) {
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
        return (
          <div
            key={item.id}
            className="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg"
          >
            {/* 状态图标 */}
            <span className={cn("shrink-0", status.color)}>{status.icon}</span>

            {/* 标题 + 状态信息 */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700 truncate">{item.title || item.url}</p>
              <p className={cn("text-xs", status.color)}>{status.text}</p>
            </div>

            {/* 删除按钮 */}
            <button
              onClick={() => onRemove(item.id)}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
