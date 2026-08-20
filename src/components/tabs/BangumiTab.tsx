import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Tv, Star, CheckCircle2, Download } from "lucide-react";
import type { BangumiFollowItem, BangumiFollowResult, ParsedVideoInfo } from "../../types";
import { friendlyError } from "../../lib/errors";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 整季批量下载（season 全部正片入队，已下载的自动跳过） */
  onBatchDownloadSeason?: (seasonId: number, title: string) => Promise<void>;
}

/** 追番/追剧 Tab：type=1 追番（番剧/国创），type=2 追剧（电影/电视剧/纪录片/综艺） */
export function BangumiTab({ onParseVideo, onSelectItem, onBatchDownloadSeason }: Props) {
  const [followType, setFollowType] = useState<1 | 2>(1);
  const [items, setItems] = useState<BangumiFollowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [parsingId, setParsingId] = useState<number | null>(null);
  const [downloadingSeason, setDownloadingSeason] = useState<number | null>(null);

  const load = useCallback(
    async (type: 1 | 2, pageNum: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else { setLoading(true); setError(null); }
      try {
        const res = await invoke<BangumiFollowResult>("get_bangumi_follow", {
          followType: type,
          page: pageNum,
        });
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setPage(pageNum);
        setHasMore(res.has_more);
        setTotal(res.total);
      } catch (e) {
        setError(friendlyError(e));
        if (!append) setItems([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    load(followType, 1, false);
  }, [followType, load]);

  // 点击条目：解析 ss{season_id} → 走 VideoDetail（选集下载 / 在线播放）
  const handleSelect = async (item: BangumiFollowItem) => {
    if (parsingId || !item.season_id) return;
    setParsingId(item.season_id);
    try {
      const info = await onParseVideo(
        `https://www.bilibili.com/bangumi/play/ss${item.season_id}`
      );
      onSelectItem(info);
    } catch {
      // 上层处理
    } finally {
      setParsingId(null);
    }
  };

  // 整季下载：season 全部正片批量入队（后端去重）
  const handleDownloadSeason = async (item: BangumiFollowItem) => {
    if (!onBatchDownloadSeason || downloadingSeason || !item.season_id) return;
    setDownloadingSeason(item.season_id);
    try {
      await onBatchDownloadSeason(item.season_id, item.title);
    } finally {
      setDownloadingSeason(null);
    }
  };

  return (
    <div>
      {/* 追番 / 追剧切换 */}
      <div className="flex gap-1 mb-4">
        {([
          { key: 1 as const, label: "追番" },
          { key: 2 as const, label: "追剧" },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFollowType(key)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              followType === key
                ? "bg-blue-50 border-blue-300 text-blue-600"
                : "bg-panel border-line text-ink-3 hover:bg-base"
            }`}
          >
            {label}
          </button>
        ))}
        {!loading && total > 0 && (
          <span className="ml-auto self-center text-xs text-ink-3">共 {total} 部</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">加载中...</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
          <button
            onClick={() => load(followType, 1, false)}
            className="text-xs text-blue-500 hover:underline"
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
          <Tv size={40} strokeWidth={1.5} />
          <p className="text-sm">{followType === 1 ? "还没有追番" : "还没有追剧"}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => (
              <BangumiCard
                key={item.season_id}
                item={item}
                loading={parsingId === item.season_id}
                seasonBusy={downloadingSeason === item.season_id}
                showSeasonDownload={!!onBatchDownloadSeason}
                onClick={() => handleSelect(item)}
                onDownloadSeason={() => handleDownloadSeason(item)}
              />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => load(followType, page + 1, true)}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-base disabled:opacity-50 transition-colors"
              >
                {loadingMore && <Loader2 size={14} className="animate-spin" />}
                {loadingMore ? "加载中..." : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 追番卡片：竖版封面 + 标题 + 更新状态 + 进度/评分角标 + 整季下载按钮 */
function BangumiCard({
  item,
  loading,
  seasonBusy,
  showSeasonDownload,
  onClick,
  onDownloadSeason,
}: {
  item: BangumiFollowItem;
  loading: boolean;
  seasonBusy: boolean;
  showSeasonDownload: boolean;
  onClick: () => void;
  onDownloadSeason: () => void;
}) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        disabled={loading || !item.season_id}
        className="flex flex-col w-full bg-panel border border-line rounded-lg overflow-hidden hover:border-line-2 transition-colors text-left disabled:opacity-70"
      >
      <div className="relative aspect-[3/4] bg-panel-2">
        <img
          src={item.cover}
          alt={item.title}
          className="w-full h-full object-cover"
          loading="lazy"
        />
        {/* 评分角标 */}
        {item.score > 0 && (
          <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-black/70 text-yellow-400 text-[10px] font-medium">
            <Star size={9} fill="currentColor" />
            {item.score.toFixed(1)}
          </span>
        )}
        {/* 会员/状态角标 */}
        {item.badge && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-pink-500/90 text-white text-[10px]">
            {item.badge}
          </span>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 size={20} className="animate-spin text-white" />
          </div>
        )}
      </div>
      <div className="p-2 flex-1 flex flex-col gap-1">
        <p className="text-xs font-medium text-ink-2 line-clamp-2 leading-snug">
          {item.title}
        </p>
        <div className="mt-auto flex items-center gap-1 text-[10px] text-ink-3">
          {item.is_finish && <CheckCircle2 size={10} className="text-green-500 shrink-0" />}
          <span className="truncate">{item.new_ep_show || item.season_type_name}</span>
        </div>
        {item.progress && (
          <p className="text-[10px] text-blue-500 truncate">{item.progress}</p>
        )}
      </div>
      </button>
      {/* 整季下载：悬浮在卡片右下角，不触发进详情 */}
      {showSeasonDownload && (
        <button
          onClick={(e) => { e.stopPropagation(); onDownloadSeason(); }}
          disabled={seasonBusy}
          title="下载整季（已下载的自动跳过）"
          className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-blue-500 transition-colors disabled:opacity-70"
        >
          {seasonBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
        </button>
      )}
    </div>
  );
}
