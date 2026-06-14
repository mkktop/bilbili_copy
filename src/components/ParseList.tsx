import {
  Search,
  Loader2,
  XCircle,
  X,
  User,
  Clock,
  Layers,
  ChevronRight,
} from "lucide-react";
import type { ParsedItem } from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";
import { HISTORY_PAGE_SIZE } from "../lib/constants";
import { Pagination } from "./Pagination";

interface ParseListProps {
  items: ParsedItem[];
  onRemove: (id: string) => void;
  onSelect: (item: ParsedItem) => void;
  currentPage: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

const STATUS_CONFIG: Record<
  string,
  { icon: React.ReactNode; text: string; color: string }
> = {
  pending: {
    icon: <Search size={14} />,
    text: "点击查看",
    color: "text-blue-400",
  },
  parsing: {
    icon: <Loader2 size={14} className="animate-spin" />,
    text: "解析中",
    color: "text-blue-500",
  },
  error: {
    icon: <XCircle size={14} />,
    text: "解析失败",
    color: "text-red-500",
  },
};

export function ParseList({ items, onRemove, onSelect, currentPage, totalCount, onPageChange }: ParseListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <Search size={40} strokeWidth={1.5} />
        <p className="text-sm">输入视频链接开始解析</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending;
        const info = item.videoInfo;

        return (
          <div
            key={item.id}
            onClick={() => {
              if (item.status !== "parsing") onSelect(item);
            }}
            className={cn(
              "flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg",
              item.status !== "parsing" && "cursor-pointer hover:bg-gray-50 hover:border-gray-300 transition-colors"
            )}
          >
            {/* 封面缩略图 */}
            {info?.pic ? (
              <img
                src={info.pic}
                alt={item.title}
                className="w-24 h-16 rounded object-cover shrink-0 bg-gray-100"
              />
            ) : (
              <div className="w-24 h-16 rounded bg-gray-100 flex items-center justify-center shrink-0">
                <Search size={20} className="text-gray-300" />
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

              {/* 状态 */}
              <div className="mt-1 flex items-center gap-1">
                <span className={cn("text-xs", status.color)}>
                  {status.icon}
                </span>
                <span className={cn("text-xs", status.color)}>
                  {status.text}
                </span>
                {item.errorMsg && (
                  <span className="text-xs text-red-400 ml-1 truncate">
                    {item.errorMsg}
                  </span>
                )}
              </div>
            </div>

            {/* 右侧：箭头 + 删除 */}
            <div className="flex items-center gap-1 shrink-0 mt-1">
              {item.status !== "parsing" && (
                <ChevronRight size={14} className="text-gray-300" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.id);
                }}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X size={14} />
              </button>
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
