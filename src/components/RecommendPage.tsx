import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  Sparkles,
  RefreshCw,
  User,
  Clock,
  Eye,
  MessageSquare,
  ThumbsUp,
} from "lucide-react";
import type { RecommendItem, ParsedVideoInfo } from "../types";
import { formatDuration } from "../types";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";
import type { UserInfo } from "../hooks/useLogin";

interface Props {
  userInfo: UserInfo | null;
  onLogin: () => void;
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function RecommendPage({
  userInfo,
  onLogin,
  onBack,
  onParseVideo,
  onSelectItem,
}: Props) {
  const [items, setItems] = useState<RecommendItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  // fresh_idx：刷新索引，每次「换一批」+1，服务端据此去重
  const freshIdx = useRef(1);
  // 请求竞态控制：刷新/重试时递增，过期响应丢弃
  const reqId = useRef(0);

  const load = useCallback(async (idx: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<RecommendItem[]>("get_recommend", {
        freshIdx: idx,
      });
      // 竞态校验：若期间又触发了刷新，丢弃本次过期响应
      if (id !== reqId.current) return;
      setItems(res);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyError(e));
      setItems([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 仅登录后才拉取
    if (userInfo) load(freshIdx.current);
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo !== null]);

  // 「换一批」：fresh_idx 递增后重新拉取
  const handleRefresh = () => {
    if (!userInfo) return;
    freshIdx.current += 1;
    load(freshIdx.current);
  };

  const handleSelect = async (item: RecommendItem) => {
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
        <Sparkles size={18} className="text-blue-500" />
        <h1 className="text-lg font-semibold text-ink">推荐视频</h1>
        {userInfo && (
          <button
            onClick={handleRefresh}
            disabled={loading}
            title="换一批"
            className="ml-auto flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            换一批
          </button>
        )}
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 未登录态：提示登录 */}
        {!userInfo ? (
          <div className="flex flex-col items-center justify-center py-20 text-ink-3 gap-3">
            <Sparkles size={48} strokeWidth={1.5} />
            <p className="text-sm text-center">
              推荐视频为个性化内容
              <br />
              请登录后查看
            </p>
            <button
              onClick={onLogin}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
            >
              去登录
            </button>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 mt-4 p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
            <button
              onClick={() => load(freshIdx.current)}
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
            <Sparkles size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无推荐内容，点「换一批」试试</p>
          </div>
        ) : (
          <div className="space-y-2 mt-4">
            {items.map((item) => (
              <RecommendCard
                key={item.bvid || item.title}
                item={item}
                loading={parsingBvid === item.bvid}
                onClick={() => handleSelect(item)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 推荐视频单条卡片：封面 + 信息 + 推荐理由徽章 */
function RecommendCard({
  item,
  loading,
  onClick,
}: {
  item: RecommendItem;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || !item.bvid}
      className="relative flex items-start gap-3 w-full px-4 py-3 bg-panel border border-line rounded-lg hover:bg-base hover:border-line-2 transition-colors text-left disabled:opacity-70"
    >
      {/* 封面 */}
      <img
        src={item.cover}
        alt={item.title}
        className="w-24 h-16 rounded object-cover bg-panel-2 shrink-0"
      />

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
          {item.title}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3 flex-wrap">
          <span className="flex items-center gap-0.5">
            <User size={10} />
            {item.upper_name}
          </span>
          {!!item.duration && item.duration > 0 && (
            <span className="flex items-center gap-0.5">
              <Clock size={10} />
              {formatDuration(item.duration)}
            </span>
          )}
          {!!item.play && item.play > 0 && (
            <span className="flex items-center gap-0.5">
              <Eye size={10} />
              {formatCount(item.play)}
            </span>
          )}
          {!!item.danmaku && item.danmaku > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {formatCount(item.danmaku)}
            </span>
          )}
          {!!item.like && item.like > 0 && (
            <span className="flex items-center gap-0.5">
              <ThumbsUp size={10} />
              {formatCount(item.like)}
            </span>
          )}
        </div>
      </div>

      {/* 推荐理由（接口有返回时显示） */}
      {!!item.rcmd_reason && (
        <div className="absolute top-1.5 right-2">
          <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 text-[10px]">
            {item.rcmd_reason}
          </span>
        </div>
      )}

      {/* 解析指示 */}
      {loading && (
        <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
      )}
    </button>
  );
}
