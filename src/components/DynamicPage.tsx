import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  Rss,
  RefreshCw,
  Clock,
  Eye,
  MessageSquare,
} from "lucide-react";
import type { DynamicItem, DynamicFeedResult, ParsedVideoInfo } from "../types";
import { friendlyError } from "../lib/errors";
import type { UserInfo } from "../hooks/useLogin";

interface Props {
  userInfo: UserInfo | null;
  onLogin: () => void;
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

/** unix 秒 → 相对时间文案（动态流习惯展示「x 分钟前 / 昨天 / 日期」） */
function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return "昨天";
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DynamicPage({
  userInfo,
  onLogin,
  onBack,
  onParseVideo,
  onSelectItem,
}: Props) {
  const [items, setItems] = useState<DynamicItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  // cursor 分页游标：下一页把上次响应的 offset 原样传回；刷新时清空
  const offsetRef = useRef("");
  // 请求竞态控制：刷新/重试时递增，过期响应丢弃
  const reqId = useRef(0);

  /** 拉取动态流：refresh=true 从头拉（清游标），否则用当前游标追加下一页 */
  const load = useCallback(async (refresh: boolean) => {
    const id = ++reqId.current;
    if (refresh) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const res = await invoke<DynamicFeedResult>("get_dynamic_feed", {
        offset: refresh ? null : offsetRef.current,
      });
      // 竞态校验：若期间又触发了刷新，丢弃本次过期响应
      if (id !== reqId.current) return;
      offsetRef.current = res.offset;
      setHasMore(res.has_more);
      setItems((prev) => (refresh ? res.items : [...prev, ...res.items]));
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyError(e));
      if (refresh) setItems([]);
    } finally {
      if (id === reqId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    // 仅登录后才拉取
    if (userInfo) load(true);
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo !== null]);

  // 无限滚动：滚动到底部附近自动加载下一页（保留「加载更多」按钮兜底）
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingMore || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      load(false);
    }
  }, [loading, loadingMore, hasMore, load]);

  const handleSelect = async (item: DynamicItem) => {
    if (parsingBvid || !item.bvid) return;
    setParsingBvid(item.bvid);
    try {
      const info = await onParseVideo(
        `https://www.bilibili.com/video/${item.bvid}`
      );
      onSelectItem(info);
    } catch {
      // 上层处理
    } finally {
      setParsingBvid(null);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      <header className="flex items-center gap-2 px-4 py-3 bg-panel border-b border-line">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-ink-3 hover:bg-panel-2 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <Rss size={18} className="text-blue-500" />
        <h1 className="text-lg font-semibold text-ink">关注动态</h1>
        {userInfo && (
          <button
            onClick={() => load(true)}
            disabled={loading}
            title="刷新"
            className="ml-auto flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto px-6 py-4">
        {/* 未登录态：提示登录 */}
        {!userInfo ? (
          <div className="flex flex-col items-center justify-center py-20 text-ink-3 gap-3">
            <Rss size={48} strokeWidth={1.5} />
            <p className="text-sm text-center">
              关注动态需要登录后查看
              <br />
              这里会展示你关注的 UP 主最新投稿
            </p>
            <button
              onClick={onLogin}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
            >
              去登录
            </button>
          </div>
        ) : error && items.length === 0 ? (
          <div className="flex items-center gap-2 mt-4 p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
            <button
              onClick={() => load(true)}
              className="ml-auto text-xs text-blue-500 hover:underline"
            >
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-ink-3">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">加载中...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <Rss size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无视频动态，关注一些 UP 主再来看看</p>
          </div>
        ) : (
          <>
            <div className="space-y-2 mt-4">
              {items.map((item) => (
                <DynamicCard
                  key={item.bvid}
                  item={item}
                  loading={parsingBvid === item.bvid}
                  onClick={() => handleSelect(item)}
                />
              ))}
            </div>
            {/* 追加分页失败时在底部提示（不清空已有列表） */}
            {error && (
              <div className="flex items-center gap-2 mt-3 p-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle size={12} />
                {error}
              </div>
            )}
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => load(false)}
                  disabled={loadingMore}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  {loadingMore && <Loader2 size={12} className="animate-spin" />}
                  {loadingMore ? "加载中..." : "加载更多"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 动态单条卡片：UP 主头像/名称/时间 + 视频封面 + 标题 + 统计文本 */
function DynamicCard({
  item,
  loading,
  onClick,
}: {
  item: DynamicItem;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || !item.bvid}
      className="flex flex-col gap-2 w-full px-4 py-3 bg-panel border border-line rounded-lg hover:bg-base hover:border-line-2 transition-colors text-left disabled:opacity-70"
    >
      {/* UP 主行：头像 + 名称 + 动作 + 相对时间 */}
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <img
          src={item.upper_face}
          alt={item.upper_name}
          className="w-6 h-6 rounded-full object-cover bg-panel-2 shrink-0"
        />
        <span className="text-ink-2 font-medium">{item.upper_name}</span>
        <span>{item.pub_action || "投稿了视频"}</span>
        <span className="ml-auto">{relativeTime(item.pub_ts)}</span>
      </div>

      {/* 视频行：封面 + 标题 + 统计 */}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <img
            src={item.cover}
            alt={item.title}
            className="w-32 h-20 rounded object-cover bg-panel-2"
          />
          {!!item.duration_text && (
            <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] leading-none">
              {item.duration_text}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
            {item.title}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3 flex-wrap">
            {!!item.play_text && (
              <span className="flex items-center gap-0.5">
                <Eye size={10} />
                {item.play_text}
              </span>
            )}
            {!!item.danmaku_text && (
              <span className="flex items-center gap-0.5">
                <MessageSquare size={10} />
                {item.danmaku_text}
              </span>
            )}
            {!!item.pub_ts && (
              <span className="flex items-center gap-0.5">
                <Clock size={10} />
                {new Date(item.pub_ts * 1000).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        {/* 解析指示 */}
        {loading && (
          <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
        )}
      </div>
    </button>
  );
}
