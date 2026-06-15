import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  LayoutGrid,
  User,
  Clock,
  Eye,
  MessageSquare,
  ThumbsUp,
} from "lucide-react";
import type { RegionItem, ParsedVideoInfo } from "../types";
import { formatDuration } from "../types";
import { TID_OPTIONS } from "../lib/constants";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

// 分区浏览不适用「全站/全分区」（rid=0 是排行榜语义），过滤掉
const REGION_OPTIONS = TID_OPTIONS.filter((o) => o.value !== "0");

export function RegionPage({ onBack, onParseVideo, onSelectItem }: Props) {
  const [rid, setRid] = useState("1"); // 1 = 动画（region 默认分区）
  const [items, setItems] = useState<RegionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  // 请求竞态控制：切换分区时递增，过期响应丢弃（防止旧响应覆盖新响应）
  const reqId = useRef(0);

  const load = useCallback(async (fRid: string) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const ridNum = Number(fRid) || 1;
      const res = await invoke<RegionItem[]>("get_region", {
        rid: ridNum,
        ps: 30,
      });
      // 竞态校验：若期间又切换了分区，丢弃本次过期响应
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
    setError(null);
    load(v);
  };

  const handleSelect = async (item: RegionItem) => {
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
  const currentLabel =
    REGION_OPTIONS.find((o) => o.value === rid)?.label ?? "";

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center gap-2 px-4 py-3 bg-white border-b border-gray-200">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-gray-500 hover:bg-gray-100 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <LayoutGrid size={18} className="text-purple-500" />
        <h1 className="text-lg font-semibold text-gray-800">分区浏览</h1>
        <span className="text-xs text-gray-400">{currentLabel}</span>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 分区筛选 */}
        <FilterRow
          label="分区"
          options={REGION_OPTIONS}
          value={rid}
          onChange={handleRidChange}
        />
        {/* 语义说明：分区浏览是该分区最新发布视频，非排行 */}
        <p className="text-[11px] text-gray-400 mt-1.5 ml-11">
          按该分区最新发布时间排序，与排行榜（综合热度）是两套不同的内容
        </p>

        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 mt-4 p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg">
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

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">加载中...</span>
          </div>
        ) : items.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <LayoutGrid size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无分区视频</p>
          </div>
        ) : (
          <div className="space-y-2 mt-4">
            {items.map((item) => (
              <RegionCard
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
                  ? "bg-purple-50 border-purple-300 text-purple-600"
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

/** 分区视频单条卡片：封面 + 标题 + UP主/时长/播放/弹幕/点赞 */
function RegionCard({
  item,
  loading,
  onClick,
}: {
  item: RegionItem;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || !item.bvid}
      className="relative flex items-start gap-3 w-full px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left disabled:opacity-70"
    >
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

      {/* 解析指示 */}
      {loading && (
        <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
      )}
    </button>
  );
}
