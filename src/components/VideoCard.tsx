import { User, Clock, Eye, MessageSquare, Loader2 } from "lucide-react";
import { formatDuration, formatDate } from "../types";

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
}: VideoCardProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="relative flex items-start gap-3 w-full px-4 py-3 bg-panel border border-line rounded-lg hover:bg-panel-2 hover:border-line-2 transition-colors text-left disabled:opacity-70"
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
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
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
      </div>

      {/* 加载指示 */}
      {loading && (
        <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
      )}
    </button>
  );
}
