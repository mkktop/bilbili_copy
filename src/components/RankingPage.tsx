import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  Trophy,
  User,
  Clock,
  Eye,
  MessageSquare,
  ThumbsUp,
} from "lucide-react";
import type { RankingItem, ParsedVideoInfo } from "../types";
import { formatDuration } from "../types";
import { TID_OPTIONS } from "../lib/constants";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function RankingPage({ onBack, onParseVideo, onSelectItem }: Props) {
  const [rid, setRid] = useState("0"); // 0 = 全站
  const [items, setItems] = useState<RankingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  // 请求竞态控制：切换筛选器时递增，过期响应丢弃（防止旧响应覆盖新响应）
  const reqId = useRef(0);

  const load = useCallback(async (fRid: string) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const ridNum = Number(fRid) || 0;
      const res = await invoke<RankingItem[]>("get_ranking", { rid: ridNum });
      // 竞态校验：若期间又切换了筛选器，丢弃本次过期响应
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
    load(rid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换分区重新拉取
  const handleRidChange = (v: string) => {
    setRid(v);
    load(v);
  };

  const handleSelect = async (item: RankingItem) => {
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

  // 当前分区名（用于标题区显示）
  const currentRidLabel =
    TID_OPTIONS.find((o) => o.value === rid)?.label ?? "全站/全分区";

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center gap-3 px-6 py-4 bg-white border-b border-gray-200">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <Trophy size={18} className="text-yellow-500" />
        <h1 className="text-lg font-semibold text-gray-800">热门排行榜</h1>
        <span className="text-xs text-gray-400">{currentRidLabel}</span>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 分区筛选 */}
        <FilterRow
          label="分区"
          options={TID_OPTIONS}
          value={rid}
          onChange={handleRidChange}
        />
        {/* 语义说明：全站榜与分区榜是两套独立算法，内容不重合属正常 */}
        <p className="text-[11px] text-gray-400 mt-1.5 ml-11">
          {rid === "0"
            ? "全站榜按全站综合热度排名（Top 100），各分区头部内容混合排序"
            : "分区榜按该分区内部数据排名，与全站榜内容不重合属正常"}
        </p>

        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mt-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
            <button
              onClick={() => load(rid)}
              className="ml-auto text-xs text-blue-500 hover:underline"
            >
              重试
            </button>
          </div>
        )}

        {/* 列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">加载中...</span>
          </div>
        ) : items.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <Trophy size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无排行榜数据</p>
          </div>
        ) : (
          <div className="space-y-2 mt-4">
            {items.map((item) => (
              <RankingCard
                key={item.bvid || `${item.rank}-${item.title}`}
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

/** 筛选器一行：左侧 label + 右侧分段按钮组（选项多时自动换行） */
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-gray-500 mt-1.5 w-8 shrink-0">{label}</span>
      <div className="flex gap-1 flex-wrap">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                active
                  ? "bg-blue-50 border-blue-300 text-blue-600"
                  : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 排行榜单条卡片：左侧名次徽章 + 封面 + 信息（含综合分） */
function RankingCard({
  item,
  loading,
  onClick,
}: {
  item: RankingItem;
  loading: boolean;
  onClick: () => void;
}) {
  // 名次配色：前 3 名突出
  const rankColor =
    item.rank === 1
      ? "bg-yellow-400 text-white"
      : item.rank === 2
      ? "bg-gray-300 text-gray-700"
      : item.rank === 3
      ? "bg-orange-400 text-white"
      : "bg-gray-100 text-gray-500";

  return (
    <button
      onClick={onClick}
      disabled={loading || !item.bvid}
      className="relative flex items-start gap-3 w-full px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left disabled:opacity-70"
    >
      {/* 名次 */}
      <div
        className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${rankColor}`}
      >
        {item.rank}
      </div>

      {/* 封面 */}
      <img
        src={item.cover}
        alt={item.title}
        className="w-24 h-16 rounded object-cover bg-gray-100 shrink-0"
      />

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
          {item.title}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400 flex-wrap">
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

      {/* 综合分 */}
      {!!item.score && item.score > 0 && (
        <div className="absolute top-1.5 right-2 flex flex-col items-end">
          <span className="text-[10px] text-gray-300">综合分</span>
          <span className="text-xs font-semibold text-gray-500">
            {formatCount(item.score)}
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
