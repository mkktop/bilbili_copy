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
  Film,
} from "lucide-react";
import type {
  RankingItem,
  PgcRankItem,
  ParsedVideoInfo,
} from "../types";
import { formatDuration } from "../types";
import {
  TID_OPTIONS,
  PGC_SEASON_TYPE_OPTIONS,
} from "../lib/constants";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

/** 内容类型：UGC（动画/游戏等用户上传） vs PGC（番剧/国创/电影等专业内容） */
type ContentType = "ugc" | "pgc";

export function RankingPage({ onBack, onParseVideo, onSelectItem }: Props) {
  const [contentType, setContentType] = useState<ContentType>("ugc");
  // UGC 用 rid (string)，PGC 用 season_type (string)，复用 rid 字段
  const [rid, setRid] = useState("0"); // UGC: 0=全站；PGC: 默认 4=国创
  const [ugcItems, setUgcItems] = useState<RankingItem[]>([]);
  const [pgcItems, setPgcItems] = useState<PgcRankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingSeasonId, setParsingSeasonId] = useState<number | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  // 请求竞态控制：切换内容类型/分区时递增，过期响应丢弃
  const reqId = useRef(0);

  const loadUgc = useCallback(async (fRid: string) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const ridNum = Number(fRid) || 0;
      const res = await invoke<RankingItem[]>("get_ranking", { rid: ridNum });
      if (id !== reqId.current) return;
      setUgcItems(res);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyError(e));
      setUgcItems([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const loadPgc = useCallback(async (fSeasonType: string) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const stNum = Number(fSeasonType) || 4;
      const res = await invoke<PgcRankItem[]>("get_pgc_rank", {
        seasonType: stNum,
      });
      if (id !== reqId.current) return;
      setPgcItems(res);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyError(e));
      setPgcItems([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // 切换内容类型：重置 rid 到各自默认值
  const handleContentTypeChange = (t: ContentType) => {
    setContentType(t);
    setError(null);
    if (t === "ugc") {
      setRid("0");
      loadUgc("0");
    } else {
      setRid("4");
      loadPgc("4");
    }
  };

  // 切换分区/season_type
  const handleRidChange = (v: string) => {
    setRid(v);
    setError(null);
    if (contentType === "ugc") loadUgc(v);
    else loadPgc(v);
  };

  useEffect(() => {
    loadUgc("0");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UGC 卡片点击：解析 bvid → onSelectItem
  const handleSelectUgc = async (item: RankingItem) => {
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

  // PGC 卡片点击：解析 ss{season_id} → onSelectItem（走 VideoDetail 选集下载）
  const handleSelectPgc = async (item: PgcRankItem) => {
    if (parsingSeasonId || !item.season_id) return;
    setParsingSeasonId(item.season_id);
    try {
      const info = await onParseVideo(
        `https://www.bilibili.com/bangumi/play/ss${item.season_id}`
      );
      onSelectItem(info);
    } catch {
      // 上层处理
    } finally {
      setParsingSeasonId(null);
    }
  };

  // 当前分区/类型标签
  const filterOptions =
    contentType === "ugc" ? TID_OPTIONS : PGC_SEASON_TYPE_OPTIONS;
  const currentLabel =
    filterOptions.find((o) => o.value === rid)?.label ?? "";

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
        <span className="text-xs text-gray-400">{currentLabel}</span>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 内容类型切换：UGC 视频 / PGC 内容（番剧/国创/电影等） */}
        <ContentTypeTabs value={contentType} onChange={handleContentTypeChange} />

        {/* 分区筛选：UGC 用一级分区，PGC 用番剧分类 */}
        <div className="mt-3">
          <FilterRow
            label={contentType === "ugc" ? "分区" : "类型"}
            options={filterOptions}
            value={rid}
            onChange={handleRidChange}
          />
        </div>

        {/* 语义说明（仅 UGC 模式有歧义时显示） */}
        {contentType === "ugc" && (
          <p className="text-[11px] text-gray-400 mt-1.5 ml-11">
            {rid === "0"
              ? "全站榜按全站综合热度排名（Top 100），各分区头部内容混合排序"
              : "分区榜按该分区内部数据排名，与全站榜内容不重合属正常"}
          </p>
        )}
        {contentType === "pgc" && (
          <p className="text-[11px] text-gray-400 mt-1.5 ml-11">
            PGC 排行榜仅含番剧/国创/电影等专业内容；点击进入选集详情页
          </p>
        )}

        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mt-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
            <button
              onClick={() =>
                contentType === "ugc" ? loadUgc(rid) : loadPgc(rid)
              }
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
        ) : contentType === "ugc" ? (
          ugcItems.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
              <Trophy size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无排行榜数据</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {ugcItems.map((item) => (
                <RankingCard
                  key={item.bvid || `${item.rank}-${item.title}`}
                  item={item}
                  loading={parsingBvid === item.bvid}
                  onClick={() => handleSelectUgc(item)}
                />
              ))}
            </div>
          )
        ) : pgcItems.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <Film size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无 PGC 排行榜数据</p>
          </div>
        ) : (
          <div className="space-y-2 mt-4">
            {pgcItems.map((item) => (
              <PgcRankCard
                key={item.season_id || `${item.rank}-${item.title}`}
                item={item}
                loading={parsingSeasonId === item.season_id}
                onClick={() => handleSelectPgc(item)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 内容类型切换：UGC 视频 / PGC 内容 */
function ContentTypeTabs({
  value,
  onChange,
}: {
  value: ContentType;
  onChange: (t: ContentType) => void;
}) {
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-lg w-fit">
      {(
        [
          { key: "ugc", label: "UGC 视频", Icon: Trophy },
          { key: "pgc", label: "PGC 内容", Icon: Film },
        ] as const
      ).map(({ key, label, Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
            value === key
              ? "bg-white text-gray-800 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
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

/** UGC 排行榜单条卡片：左侧名次徽章 + 封面 + 信息（含综合分） */
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

      {/* 综合分（v2 接口通常为 0，不显示） */}
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

/** PGC 排行榜单条卡片：横向封面 + 标题 + 状态标签 + 综合分 */
function PgcRankCard({
  item,
  loading,
  onClick,
}: {
  item: PgcRankItem;
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
      disabled={loading || !item.season_id}
      className="relative flex items-start gap-3 w-full px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left disabled:opacity-70"
    >
      {/* 名次 */}
      <div
        className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${rankColor}`}
      >
        {item.rank}
      </div>

      {/* 横向封面（16:9 比例更适合展示） */}
      <img
        src={item.cover}
        alt={item.title}
        className="w-32 h-18 rounded object-cover bg-gray-100 shrink-0"
        style={{ aspectRatio: "16/9" }}
      />

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
          {item.title}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400 flex-wrap">
          {!!item.badge && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-pink-50 text-pink-500 text-[10px]">
              {item.badge}
            </span>
          )}
          {!!item.views && item.views > 0 && (
            <span className="flex items-center gap-0.5">
              <Eye size={10} />
              {formatCount(item.views)}
            </span>
          )}
          {!!item.danmaku && item.danmaku > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {formatCount(item.danmaku)}
            </span>
          )}
        </div>
      </div>

      {/* 综合分（PGC 接口真实返回，总是显示） */}
      {!!item.score && item.score > 0 && (
        <div className="absolute top-1.5 right-2 flex flex-col items-end">
          <span className="text-[10px] text-gray-300">综合分</span>
          <span className="text-xs font-semibold text-yellow-600">
            {item.score}
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
