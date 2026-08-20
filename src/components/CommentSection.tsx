import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  MessageSquare,
  ThumbsUp,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { CommentItem, PagedResult } from "../types";
import { formatDate } from "../types";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";
import { cn } from "../lib/utils";

interface Props {
  /** 视频 aid（作为 oid 传给评论接口） */
  aid: number;
}

/** 排序模式：3=按热度，2=按时间（与后端 /x/v2/reply 的 mode 参数一致） */
type CommentMode = 3 | 2;

export function CommentSection({ aid }: Props) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CommentMode>(3);

  // 请求序号：刷新会重置列表，若"加载更多"的在途请求晚于刷新返回，
  // 会把旧页 append 回来造成评论重复 —— 过期请求的响应直接丢弃。
  const reqSeq = useRef(0);
  const load = useCallback(
    async (pn: number, append: boolean, m: CommentMode) => {
      const seq = ++reqSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append) setError(null);
      try {
        const res = await invoke<PagedResult<CommentItem>>(
          "get_video_comments",
          { aid, pn, mode: m }
        );
        if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃本次响应
        setComments((prev) => (append ? [...prev, ...res.items] : res.items));
        setPage(pn);
        setHasMore(res.has_more);
        setTotal(res.total);
      } catch (e) {
        if (seq !== reqSeq.current) return;
        if (!append) setError(friendlyError(e));
      } finally {
        if (seq === reqSeq.current) {
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [aid]
  );

  // aid 变化时（切换视频）重新加载第一页
  useEffect(() => {
    setMode(3);
    load(1, false, 3);
  }, [load]);

  // 切换排序：回到第 1 页重新拉取
  const switchMode = (m: CommentMode) => {
    if (m === mode) return;
    setMode(m);
    load(1, false, m);
  };

  return (
    <div className="px-6 py-4 border-t border-line mt-2">
      {/* 标题栏：评论数 + 排序切换 + 刷新 */}
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={15} className="text-ink-3" />
        <h3 className="text-sm font-semibold text-ink-2">
          评论
          {total > 0 && (
            <span className="ml-1 text-xs font-normal text-ink-3">
              {formatCount(total)}
            </span>
          )}
        </h3>

        {/* 排序切换：最热 / 最新 */}
        <div className="flex rounded-md border border-line p-0.5 bg-panel-2 ml-2">
          {(
            [
              { m: 3 as CommentMode, label: "最热" },
              { m: 2 as CommentMode, label: "最新" },
            ]
          ).map(({ m, label }) => (
            <button
              key={label}
              onClick={() => switchMode(m)}
              className={cn(
                "px-2 py-0.5 text-[11px] rounded transition-colors",
                mode === m
                  ? "bg-panel text-accent font-medium shadow-sm"
                  : "text-ink-3 hover:text-ink-2"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={() => load(1, false, mode)}
          disabled={loading || loadingMore}
          title="刷新评论"
          className="ml-auto p-1 rounded text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors disabled:opacity-50"
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
            onClick={() => load(1, false, mode)}
            className="ml-auto text-blue-500 hover:underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 加载中（首屏） */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-3">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-xs">加载评论...</span>
        </div>
      ) : comments.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center py-8 text-ink-3 gap-1.5">
          <MessageSquare size={32} strokeWidth={1.5} />
          <p className="text-xs">暂无评论</p>
        </div>
      ) : (
        <>
          {/* 评论列表 */}
          <div className="space-y-3">
            {comments.map((c) => (
              <CommentRow key={c.rpid} item={c} aid={aid} />
            ))}
          </div>

          {/* 加载更多 */}
          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => load(page + 1, true, mode)}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
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

/** 单条评论：头像 + 用户名/等级/楼层 + 内容 + 点赞/回复数 + 楼中楼展开 */
function CommentRow({ item, aid }: { item: CommentItem; aid: number }) {
  // 楼中楼状态：null=未展开；{items, hasMore, loading, page}=已展开
  const [replies, setReplies] = useState<CommentItem[] | null>(null);
  const [repliesTotal, setRepliesTotal] = useState(0);
  const [repliesPage, setRepliesPage] = useState(1);
  const [repliesMore, setRepliesMore] = useState(false);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const reqSeq = useRef(0);

  const loadReplies = useCallback(
    async (pn: number, append: boolean) => {
      const seq = ++reqSeq.current;
      setLoadingReplies(true);
      try {
        const res = await invoke<PagedResult<CommentItem>>(
          "get_comment_replies",
          { aid, root: item.rpid, pn }
        );
        if (seq !== reqSeq.current) return;
        setReplies((prev) => (append && prev ? [...prev, ...res.items] : res.items));
        setRepliesTotal(res.total);
        setRepliesPage(pn);
        setRepliesMore(res.has_more);
      } catch {
        if (seq !== reqSeq.current) return;
        setReplies([]);
        setRepliesMore(false);
      } finally {
        if (seq === reqSeq.current) setLoadingReplies(false);
      }
    },
    [aid, item.rpid]
  );

  const toggleReplies = () => {
    if (replies !== null) {
      setReplies(null);
    } else {
      loadReplies(1, false);
    }
  };

  return (
    <div className="flex gap-2.5">
      {/* 头像 */}
      <img
        src={item.avatar}
        alt={item.uname}
        className="w-7 h-7 rounded-full object-cover bg-panel-2 shrink-0"
      />

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        {/* 用户名 + 等级 + 楼层 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-ink-2">
            {item.uname}
          </span>
          {item.level > 0 && (
            <span className="px-1 rounded text-[9px] text-white bg-orange-400 leading-tight">
              Lv{item.level}
            </span>
          )}
          {item.floor > 0 && (
            <span className="text-[10px] text-ink-3">#{item.floor}</span>
          )}
        </div>

        {/* 评论正文（保留换行） */}
        <p className="text-xs text-ink-2 mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
          {item.content}
        </p>

        {/* 底部：时间 + 点赞 + 回复数（可展开楼中楼） */}
        <div className="flex items-center gap-3 mt-1 text-[10px] text-ink-3">
          {item.ctime > 0 && <span>{formatDate(item.ctime)}</span>}
          {item.like > 0 && (
            <span className="flex items-center gap-0.5">
              <ThumbsUp size={10} />
              {formatCount(item.like)}
            </span>
          )}
          {item.reply_count > 0 && (
            <button
              onClick={toggleReplies}
              className="flex items-center gap-0.5 hover:text-accent transition-colors"
            >
              {replies !== null ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              {replies !== null ? "收起回复" : `回复 ${formatCount(item.reply_count)}`}
            </button>
          )}
        </div>

        {/* 楼中楼：缩进的子回复列表 */}
        {replies !== null && (
          <div className="mt-2 pl-2 border-l-2 border-line space-y-2">
            {loadingReplies && replies.length === 0 && (
              <div className="flex items-center gap-1.5 py-1 text-ink-3">
                <Loader2 size={11} className="animate-spin" />
                <span className="text-[10px]">加载回复...</span>
              </div>
            )}
            {replies.map((r) => (
              <div key={r.rpid} className="flex gap-2">
                <img
                  src={r.avatar}
                  alt={r.uname}
                  className="w-5 h-5 rounded-full object-cover bg-panel-2 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-medium text-ink-2">{r.uname}</span>
                    {r.level > 0 && (
                      <span className="px-1 rounded text-[9px] text-white bg-orange-400 leading-tight">
                        Lv{r.level}
                      </span>
                    )}
                    {r.ctime > 0 && (
                      <span className="text-[10px] text-ink-3">{formatDate(r.ctime)}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-2 mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
                    {r.content}
                  </p>
                  {r.like > 0 && (
                    <span className="flex items-center gap-0.5 mt-0.5 text-[10px] text-ink-3">
                      <ThumbsUp size={9} />
                      {formatCount(r.like)}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {repliesMore && (
              <button
                onClick={() => loadReplies(repliesPage + 1, true)}
                disabled={loadingReplies}
                className="text-[10px] text-accent hover:underline disabled:opacity-50"
              >
                {loadingReplies ? "加载中..." : `加载更多回复（共 ${formatCount(repliesTotal)} 条）`}
              </button>
            )}
            {!repliesMore && replies.length > 0 && repliesTotal > replies.length && (
              <span className="text-[10px] text-ink-3">
                共 {formatCount(repliesTotal)} 条回复
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
