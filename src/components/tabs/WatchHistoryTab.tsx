import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, History } from "lucide-react";
import type {
  HistoryItem,
  PagedResult,
  ParsedVideoInfo,
} from "../../types";
import { VideoCard } from "../VideoCard";
import { friendlyError } from "../../lib/errors";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

/**
 * 观看历史 Tab（cursor 分页）。
 * cursor 分页机制：每页返回的最后一条 view_at 作为下一页的 max_view_at，
 * 首页传 null。has_more 由后端按「返回条数 == 页大小」判断。
 */
export function WatchHistoryTab({ onParseVideo, onSelectItem }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  // 下一页游标：上一次返回的最后一条 view_at；null 表示首页或无更多
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: number | null, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      if (!append) setError(null);
      try {
        const res = await invoke<PagedResult<HistoryItem>>("get_watch_history", {
          maxViewAt: cursor,
        });
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        // 下一页游标：本页最后一条的 view_at（按时间倒序，最后一条最旧）
        const last = res.items[res.items.length - 1];
        setNextCursor(last ? last.view_at : null);
        setHasMore(res.has_more);
      } catch (e) {
        const msg = friendlyError(e);
        setError(msg);
        if (!append) setItems([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    load(null, false);
  }, [load]);

  const handleSelect = async (item: HistoryItem) => {
    if (parsingBvid || !item.bvid) return;
    setParsingBvid(item.bvid);
    try {
      const videoInfo = await onParseVideo(
        `https://www.bilibili.com/video/${item.bvid}`
      );
      onSelectItem(videoInfo);
    } catch {
      // 解析失败已在上层处理
    } finally {
      setParsingBvid(null);
    }
  };

  /** 计算已观看百分比文案（duration <= 0 时返回 null，不显示 badge） */
  const progressBadge = (item: HistoryItem): string | undefined => {
    if (!item.duration || item.duration <= 0) return undefined;
    // progress == -1 表示已看完
    if (item.progress < 0) return "已看完";
    const pct = Math.min(100, Math.round((item.progress / item.duration) * 100));
    if (pct <= 0) return undefined;
    return pct >= 100 ? "已看完" : `已看 ${pct}%`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
        <AlertCircle size={20} />
        <p className="text-sm">{error}</p>
        <button
          onClick={() => load(null, false)}
          className="text-xs text-blue-500 hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
        <History size={40} strokeWidth={1.5} />
        <p className="text-sm">暂无观看历史</p>
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-2">
        {items.map((item) => (
          <VideoCard
            key={`${item.bvid}-${item.view_at}` || item.title}
            title={item.title}
            cover={item.cover}
            upperName={item.upper_name}
            duration={item.duration}
            play={item.play}
            danmaku={item.danmaku}
            pubdate={item.view_at || item.pubdate}
            badge={progressBadge(item)}
            loading={parsingBvid === item.bvid}
            disabled={!item.bvid}
            onClick={() => handleSelect(item)}
          />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-4">
          <button
            onClick={() => load(nextCursor, true)}
            disabled={loadingMore}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {loadingMore ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                加载中...
              </>
            ) : (
              "加载更多"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
