import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  MessageSquare,
  ThumbsUp,
  RefreshCw,
} from "lucide-react";
import type { CommentItem, PagedResult } from "../types";
import { formatDate } from "../types";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";

interface Props {
  /** 视频 aid（作为 oid 传给评论接口） */
  aid: number;
}

export function CommentSection({ aid }: Props) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (pn: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append) setError(null);
      try {
        const res = await invoke<PagedResult<CommentItem>>(
          "get_video_comments",
          { aid, pn }
        );
        setComments((prev) => (append ? [...prev, ...res.items] : res.items));
        setPage(pn);
        setHasMore(res.has_more);
        setTotal(res.total);
      } catch (e) {
        if (!append) setError(friendlyError(e));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [aid]
  );

  // aid 变化时（切换视频）重新加载第一页
  useEffect(() => {
    load(1, false);
  }, [load]);

  return (
    <div className="px-6 py-4 border-t border-gray-100 mt-2">
      {/* 标题栏：评论数 + 刷新 */}
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={15} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-700">
          评论
          {total > 0 && (
            <span className="ml-1 text-xs font-normal text-gray-400">
              {formatCount(total)}
            </span>
          )}
        </h3>
        <button
          onClick={() => load(1, false)}
          disabled={loading}
          title="刷新评论"
          className="ml-auto p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 错误 */}
      {error && (
        <div className="flex items-center gap-2 mb-3 p-2.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={13} />
          {error}
          <button
            onClick={() => load(1, false)}
            className="ml-auto text-blue-500 hover:underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 加载中（首屏） */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-xs">加载评论...</span>
        </div>
      ) : comments.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center py-8 text-gray-400 gap-1.5">
          <MessageSquare size={32} strokeWidth={1.5} />
          <p className="text-xs">暂无评论</p>
        </div>
      ) : (
        <>
          {/* 评论列表 */}
          <div className="space-y-3">
            {comments.map((c) => (
              <CommentRow key={c.rpid} item={c} />
            ))}
          </div>

          {/* 加载更多 */}
          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => load(page + 1, true)}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    加载中...
                  </>
                ) : (
                  "加载更多"
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 单条评论：头像 + 用户名/等级/楼层 + 内容 + 点赞/回复数 */
function CommentRow({ item }: { item: CommentItem }) {
  return (
    <div className="flex gap-2.5">
      {/* 头像 */}
      <img
        src={item.avatar}
        alt={item.uname}
        className="w-7 h-7 rounded-full object-cover bg-gray-100 shrink-0"
      />

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        {/* 用户名 + 等级 + 楼层 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-gray-600">
            {item.uname}
          </span>
          {item.level > 0 && (
            <span className="px-1 rounded text-[9px] text-white bg-orange-400 leading-tight">
              Lv{item.level}
            </span>
          )}
          {item.floor > 0 && (
            <span className="text-[10px] text-gray-400">#{item.floor}</span>
          )}
        </div>

        {/* 评论正文（保留换行） */}
        <p className="text-xs text-gray-700 mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
          {item.content}
        </p>

        {/* 底部：时间 + 点赞 + 回复数 */}
        <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
          {item.ctime > 0 && <span>{formatDate(item.ctime)}</span>}
          {item.like > 0 && (
            <span className="flex items-center gap-0.5">
              <ThumbsUp size={10} />
              {formatCount(item.like)}
            </span>
          )}
          {item.reply_count > 0 && (
            <span>回复 {formatCount(item.reply_count)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
