import { User, Clock, Eye, MessageSquare, Loader2, CheckCircle2 } from "lucide-react";
import { formatDuration, formatDate } from "../types";
import { cn } from "../lib/utils";

interface VideoCardProps {
  title: string;
  cover: string;
  upperName?: string;
  /** 秒；null/0 表示未知 */
  duration?: number | null;
  play?: number;
  danmaku?: number;
  /** unix 秒 */
  pubdate?: number;
  /** 右上角角标文字 */
  badge?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  // ---- 批量选择模式（列表页批量下载）----
  /** 开启后点击卡片切换选中态（不再进详情） */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** 行尾追加内容（如移除按钮），不占点击区 */
  trailing?: React.ReactNode;
}

/** 格式化播放量：万 / 亿。统一版本，供全项目复用。 */
export function formatCount(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
  if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
  return String(n);
}

export function VideoCard({
  title,
  cover,
  upperName,
  duration,
  play,
  danmaku,
  pubdate,
  badge,
  loading,
  disabled,
  onClick,
  selectMode,
  selected,
  onToggleSelect,
  trailing,
}: VideoCardProps) {
  return (
    <div
      onClick={selectMode && onToggleSelect ? onToggleSelect : undefined}
      className={cn(
        "relative flex items-start gap-3 w-full px-4 py-3 bg-panel border rounded-lg transition-colors text-left",
        selectMode ? "cursor-pointer" : "hover:bg-panel-2 hover:border-line-2",
        selected
          ? "border-blue-300 bg-blue-50"
          : "border-line",
        disabled && "opacity-70"
      )}
    >
      {/* 封面 */}
      <div className="relative shrink-0">
        <img
          src={cover}
          alt={title}
          className="w-24 h-16 rounded object-cover bg-panel-2"
        />
        {!!badge && (
          <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-white text-[10px] leading-none">
            {badge}
          </span>
        )}
        {/* 选中标记 */}
        {selectMode && (
          <span
            className={cn(
              "absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full flex items-center justify-center border-2",
              selected ? "bg-blue-500 border-blue-500" : "bg-panel border-line-2"
            )}
          >
            {selected && <CheckCircle2 size={12} className="text-white" />}
          </span>
        )}
      </div>

      {/* 信息 */}
      <button
        type="button"
        onClick={
          selectMode && onToggleSelect ? undefined : disabled || loading ? undefined : onClick
        }
        disabled={disabled || loading}
        className={cn(
          "flex-1 min-w-0 text-left",
          !selectMode && !disabled && !loading && "cursor-pointer"
        )}
      >
        <p className="text-sm text-ink-2 line-clamp-2 leading-snug">{title}</p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3 flex-wrap">
          {upperName && (
            <span className="flex items-center gap-0.5">
              <User size={10} />
              {upperName}
            </span>
          )}
          {!!duration && duration > 0 && (
            <span className="flex items-center gap-0.5">
              <Clock size={10} />
              {formatDuration(duration)}
            </span>
          )}
          {!!play && play > 0 && (
            <span className="flex items-center gap-0.5">
              <Eye size={10} />
              {formatCount(play)}
            </span>
          )}
          {!!danmaku && danmaku > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {formatCount(danmaku)}
            </span>
          )}
          {!!pubdate && <span>{formatDate(pubdate)}</span>}
        </div>
      </button>

      {/* 行尾（移除按钮等）+ 加载指示 */}
      {trailing}
      {loading && (
        <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
      )}
    </div>
  );
}
