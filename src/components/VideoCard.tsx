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
  const choose = selectMode && onToggleSelect ? onToggleSelect : onClick;
  return (
    <div className={cn("library-video-card relative flex items-start gap-3 w-full border rounded-xl transition-colors text-left", selected ? "border-accent/40 bg-accent-soft" : "border-line bg-panel", disabled && "opacity-70")}>
      <button type="button" onClick={choose} disabled={disabled || loading} aria-label={title} aria-pressed={selectMode ? !!selected : undefined}
        className="flex items-start gap-3 flex-1 min-w-0 p-4 text-left rounded-xl hover:bg-panel-2 transition-colors disabled:cursor-wait">
        <span className="relative shrink-0">
          <img src={cover} alt="" loading="lazy" className="w-24 h-16 rounded-md object-cover bg-panel-2" />
          {!!badge && <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-white text-[10px] leading-none">{badge}</span>}
          {selectMode && <span className={cn("absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full flex items-center justify-center border-2", selected ? "bg-blue-500 border-blue-500" : "bg-panel border-line-2")}>{selected && <CheckCircle2 size={12} className="text-white" />}</span>}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-ink line-clamp-2 leading-snug">{title}</span>
          <span className="flex items-center gap-x-3 gap-y-1 mt-2 text-xs text-ink-3 flex-wrap">
            {upperName && <span className="flex items-center gap-1"><User size={11} />{upperName}</span>}
            {!!duration && duration > 0 && <span className="flex items-center gap-1"><Clock size={11} />{formatDuration(duration)}</span>}
            {!!play && play > 0 && <span className="flex items-center gap-1"><Eye size={11} />{formatCount(play)}</span>}
            {!!danmaku && danmaku > 0 && <span className="flex items-center gap-1"><MessageSquare size={11} />{formatCount(danmaku)}</span>}
            {!!pubdate && <span>{formatDate(pubdate)}</span>}
          </span>
        </span>
      </button>
      {trailing && <div className="pr-3 pt-4 shrink-0">{trailing}</div>}
      {loading && <Loader2 size={16} className="animate-spin text-accent shrink-0 mt-4 mr-3" />}
    </div>
  );
}
