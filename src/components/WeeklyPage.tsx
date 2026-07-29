import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  User,
  Clock,
  Eye,
  MessageSquare,
  ThumbsUp,
  Play,
  ChevronDown,
  Tag,
} from "lucide-react";
import type {
  WeeklySeriesItem,
  WeeklyDetail,
  WeeklyVideoItem,
  ParsedVideoInfo,
  PlaylistItem,
} from "../types";
import { formatDuration } from "../types";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 连续播放：传入播放列表，打开播放器 */
  onPlayPlaylist?: (items: PlaylistItem[], startIndex: number) => void;
}

export function WeeklyPage({ onBack, onParseVideo, onSelectItem, onPlayPlaylist }: Props) {
  const [seriesList, setSeriesList] = useState<WeeklySeriesItem[]>([]);
  const [detail, setDetail] = useState<WeeklyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  const reqId = useRef(0);
  const selectorRef = useRef<HTMLDivElement>(null);

  // 加载期数列表（仅首次）
  useEffect(() => {
    invoke<WeeklySeriesItem[]>("get_weekly_series")
      .then(setSeriesList)
      .catch(() => {});
  }, []);

  // 加载某期详情（不传 number 则最新一期）
  const loadDetail = useCallback(async (number?: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<WeeklyDetail>("get_weekly_detail", { number: number ?? null });
      if (id !== reqId.current) return;
      setDetail(res);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyError(e));
      setDetail(null);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // 首次加载最新一期
  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // 点击外部关闭选择器
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 选择某期
  const handleSelectSeries = (item: WeeklySeriesItem) => {
    setSelectorOpen(false);
    loadDetail(item.number);
  };

  // 点击视频卡片：解析 → 进入详情
  const handleSelectVideo = async (item: WeeklyVideoItem) => {
    if (parsingBvid || !item.bvid) return;
    setParsingBvid(item.bvid);
    try {
      const info = await onParseVideo(`https://www.bilibili.com/video/${item.bvid}`);
      onSelectItem(info);
    } catch {
      // 上层处理
    } finally {
      setParsingBvid(null);
    }
  };

  // 连续播放：从某条开始播放本期全部
  const handlePlayAll = (startIndex: number) => {
    if (!detail || !onPlayPlaylist) return;
    const items: PlaylistItem[] = detail.list.map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      cid: v.cid,
      title: v.title,
      duration: v.duration,
      cover: v.cover,
      upper_name: v.upper_name,
    }));
    onPlayPlaylist(items, startIndex);
  };

  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      <header className="flex items-center gap-3 px-6 py-4 bg-panel border-b border-line">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-base transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <CalendarDays size={18} className="text-pink-500" />
        <h1 className="text-lg font-semibold text-ink">每周必看</h1>

        {/* 期数选择器 */}
        {seriesList.length > 0 && (
          <div className="relative ml-2" ref={selectorRef}>
            <button
              onClick={() => setSelectorOpen((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line bg-panel-2 hover:bg-base transition-colors"
            >
              <span className="max-w-[200px] truncate">
                {detail ? `第${detail.config.number}期` : "选择期数"}
              </span>
              <ChevronDown size={14} className={`transition-transform ${selectorOpen ? "rotate-180" : ""}`} />
            </button>
            {selectorOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-[320px] max-h-[50vh] overflow-auto rounded-lg bg-panel border border-line shadow-xl py-1">
                {seriesList.slice(0, 50).map((s) => (
                  <button
                    key={s.number}
                    onClick={() => handleSelectSeries(s)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-panel-2 ${
                      detail?.config.number === s.number ? "text-accent font-medium" : "text-ink-2"
                    }`}
                  >
                    <span className="shrink-0 text-xs text-ink-3 w-14">第{s.number}期</span>
                    <span className="truncate flex-1">{s.subject}</span>
                    <span className="shrink-0 text-[10px] text-ink-3">{s.name.split(" ").slice(1).join(" ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
            <button
              onClick={() => loadDetail(detail?.config.number)}
              className="ml-auto text-xs text-blue-500 hover:underline"
            >
              重试
            </button>
          </div>
        )}

        {/* 加载中 */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">加载中...</span>
          </div>
        ) : detail ? (
          <>
            {/* 期数信息头 */}
            <div className="flex items-center gap-4 mb-4">
              {detail.config.cover && (
                <img
                  src={detail.config.cover}
                  alt=""
                  className="w-20 h-20 rounded-lg object-cover bg-panel-2 shrink-0"
                />
              )}
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">{detail.config.subject}</h2>
                <p className="text-xs text-ink-3 mt-1">{detail.config.name}</p>
                {detail.reminder && (
                  <p className="text-xs text-pink-500 mt-0.5">{detail.reminder}</p>
                )}
                {detail.config.hint && (
                  <p className="text-xs text-ink-3 mt-0.5">{detail.config.hint}</p>
                )}
              </div>
              {/* 连续播放按钮 */}
              {onPlayPlaylist && detail.list.length > 0 && (
                <button
                  onClick={() => handlePlayAll(0)}
                  className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-pink-500 text-white text-sm font-medium hover:bg-pink-600 transition-colors shrink-0"
                >
                  <Play size={14} />
                  连续播放
                </button>
              )}
            </div>

            {/* 视频列表 */}
            {detail.list.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
                <CalendarDays size={40} strokeWidth={1.5} />
                <p className="text-sm">本期暂无视频</p>
              </div>
            ) : (
              <div className="space-y-2">
                {detail.list.map((item, idx) => (
                  <WeeklyCard
                    key={item.bvid || idx}
                    item={item}
                    index={idx + 1}
                    loading={parsingBvid === item.bvid}
                    onClick={() => handleSelectVideo(item)}
                    onPlay={onPlayPlaylist ? () => handlePlayAll(idx) : undefined}
                  />
                ))}
              </div>
            )}
          </>
        ) : !error ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <CalendarDays size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无数据</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 每周必看视频卡片：序号 + 封面 + 信息 + 推荐理由 + 播放按钮 */
function WeeklyCard({
  item,
  index,
  loading,
  onClick,
  onPlay,
}: {
  item: WeeklyVideoItem;
  index: number;
  loading: boolean;
  onClick: () => void;
  onPlay?: () => void;
}) {
  return (
    <div className="relative flex items-start gap-3 w-full px-4 py-3 bg-panel border border-line rounded-lg hover:bg-base hover:border-line-2 transition-colors">
      {/* 序号 */}
      <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 bg-panel-2 text-ink-3">
        {index}
      </div>

      {/* 封面（可点击进入详情） */}
      <button onClick={onClick} disabled={loading || !item.bvid} className="shrink-0 disabled:opacity-70">
        <img
          src={item.cover}
          alt={item.title}
          className="w-24 h-16 rounded object-cover bg-panel-2"
        />
      </button>

      {/* 信息（可点击进入详情） */}
      <button onClick={onClick} disabled={loading || !item.bvid} className="flex-1 min-w-0 text-left disabled:opacity-70">
        <p className="text-sm text-ink-2 line-clamp-2 leading-snug">{item.title}</p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3 flex-wrap">
          <span className="flex items-center gap-0.5">
            <User size={10} />
            {item.upper_name}
          </span>
          {item.duration > 0 && (
            <span className="flex items-center gap-0.5">
              <Clock size={10} />
              {formatDuration(item.duration)}
            </span>
          )}
          {item.play > 0 && (
            <span className="flex items-center gap-0.5">
              <Eye size={10} />
              {formatCount(item.play)}
            </span>
          )}
          {item.danmaku > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {formatCount(item.danmaku)}
            </span>
          )}
          {item.like > 0 && (
            <span className="flex items-center gap-0.5">
              <ThumbsUp size={10} />
              {formatCount(item.like)}
            </span>
          )}
          {item.tname && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-panel-2 text-[10px]">
              <Tag size={9} />
              {item.tname}
            </span>
          )}
        </div>
        {/* 推荐理由 */}
        {item.rcmd_reason && (
          <p className="text-[11px] text-pink-500 mt-1 line-clamp-1 italic">
            {item.rcmd_reason}
          </p>
        )}
      </button>

      {/* 右侧操作：播放按钮 */}
      <div className="flex items-center gap-1.5 shrink-0 mt-1">
        {onPlay && (
          <button
            onClick={onPlay}
            title="从此开始连续播放"
            className="p-1.5 rounded-lg text-pink-500 hover:bg-pink-50 transition-colors"
          >
            <Play size={15} />
          </button>
        )}
        {loading && (
          <Loader2 size={16} className="animate-spin text-blue-500" />
        )}
      </div>
    </div>
  );
}
