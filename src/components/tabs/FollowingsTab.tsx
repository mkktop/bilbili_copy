import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Users } from "lucide-react";
import type { FollowingItem, PagedResult } from "../../types";
import { friendlyError } from "../../lib/errors";

interface Props {
  onSelectUpper: (mid: number) => void;
}

export function FollowingsTab({ onSelectUpper }: Props) {
  const [items, setItems] = useState<FollowingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number, append: boolean) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    if (!append) setError(null);
    try {
      const res = await invoke<PagedResult<FollowingItem>>("get_followings", {
        page: p,
      });
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
      setPage(res.page);
      setHasMore(res.has_more);
    } catch (e) {
      const msg = friendlyError(e);
      if (append) {
        setError(msg);
      } else {
        setError(msg);
        setItems([]);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load(1, false);
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
        <AlertCircle size={20} />
        <p className="text-sm">{error}</p>
        <button
          onClick={() => load(1, false)}
          className="text-xs text-blue-500 hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
        <Users size={40} strokeWidth={1.5} />
        <p className="text-sm">没有关注的 UP 主</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-ink-3 mb-3">共 {total} 个关注</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {items.map((item) => (
          <button
            key={item.mid}
            onClick={() => onSelectUpper(item.mid)}
            className="flex items-center gap-3 px-4 py-3 bg-panel border border-line rounded-lg hover:bg-panel-2 hover:border-line-2 transition-colors text-left"
          >
            <img
              src={item.face}
              alt={item.name}
              className="w-12 h-12 rounded-full object-cover bg-panel-2 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-2 truncate">
                {item.name}
              </p>
              <p className="text-xs text-ink-3 mt-0.5 line-clamp-1">
                {item.sign || "这个UP主很懒，什么都没写"}
              </p>
            </div>
          </button>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-4">
          <button
            onClick={() => load(page + 1, true)}
            disabled={loadingMore}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
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
