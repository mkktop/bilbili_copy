import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  Bookmark,
  Layers,
  ArrowLeft,
  Bell,
  Check,
  Trash2,
  RefreshCw,
} from "lucide-react";
import type {
  SubscribedCollection,
  VideoListItem,
  PagedResult,
  FavoriteMedia,
  FavoriteListResult,
  ParsedVideoInfo,
  SubscriptionEntry,
  SubscriptionCheckResult,
} from "../../types";
import { VideoCard } from "../VideoCard";
import { BatchBar } from "../BatchBar";
import { useToast } from "../Toast";
import { friendlyError } from "../../lib/errors";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载已选视频 */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
}

/** 本地订阅追更管理：列出订阅（定时自动检查，也可手动「立即检查」） */
function SubscriptionManager() {
  const [subs, setSubs] = useState<SubscriptionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<SubscriptionEntry[]>("get_subscriptions");
      setSubs(list);
    } catch {
      setSubs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCheck = async (sub: SubscriptionEntry) => {
    if (checkingId !== null) return;
    setCheckingId(sub.id);
    try {
      const res = await invoke<SubscriptionCheckResult>("check_subscription", { id: sub.id });
      if (res.queued > 0) {
        toast.success(`「${sub.title}」发现 ${res.queued} 个新内容，已加入下载队列`);
      } else {
        toast.info(`「${sub.title}」暂无更新`);
      }
      load();
    } catch (e) {
      toast.error(`检查失败：${friendlyError(e)}`);
    } finally {
      setCheckingId(null);
    }
  };

  const handleRemove = async (sub: SubscriptionEntry) => {
    setSubs((prev) => prev.filter((s) => s.id !== sub.id));
    try {
      await invoke("remove_subscription", { id: sub.id });
    } catch (e) {
      toast.error(`删除失败：${friendlyError(e)}`);
      load();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-ink-3">
        <Loader2 size={14} className="animate-spin" />
        <span className="text-xs">加载订阅...</span>
      </div>
    );
  }

  if (subs.length === 0) return null;

  return (
    <section className="mb-5">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2 mb-2">
        <Bell size={13} className="text-blue-500" />
        追更订阅（新内容自动下载）
      </h3>
      <div className="space-y-1.5">
        {subs.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2.5 px-3 py-2 bg-panel border border-blue-100 rounded-lg"
          >
            {s.cover ? (
              <img src={s.cover} alt="" className="w-10 h-10 rounded object-cover shrink-0 bg-panel-2" />
            ) : (
              <Layers size={16} className="text-blue-400 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink-2 truncate">{s.title}</p>
              <p className="text-[10px] text-ink-3 mt-0.5">
                {s.kind === "favorite" ? "收藏夹" : s.kind === "series" ? "列表" : "合集"}
                {s.upper_name && ` · ${s.upper_name}`}
                {s.last_check && ` · 上次检查 ${s.last_check.slice(5, 16)}`}
              </p>
            </div>
            <button
              onClick={() => handleCheck(s)}
              disabled={checkingId !== null}
              title="立即检查更新"
              className="p-1.5 rounded-lg text-blue-500 hover:bg-blue-50 transition-colors disabled:opacity-50"
            >
              {checkingId === s.id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
            </button>
            <button
              onClick={() => handleRemove(s)}
              title="取消订阅"
              className="p-1.5 rounded-lg text-ink-3 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SubscriptionsTab({ onParseVideo, onSelectItem, onBatchDownload }: Props) {
  const [collections, setCollections] = useState<SubscribedCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<SubscribedCollection | null>(null);
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [videoPage, setVideoPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  // 批量下载选择 + 订阅状态
  const [selectMode, setSelectMode] = useState(false);
  const [selectedBvids, setSelectedBvids] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [subscribedKey, setSubscribedKey] = useState<string | null>(null);

  const toast = useToast();

  const loadCollections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<SubscribedCollection[]>(
        "get_subscribed_collections"
      );
      setCollections(result);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  const loadVideos = useCallback(
    async (c: SubscribedCollection, page: number, append: boolean) => {
      setLoadingVideos(true);
      setVideoError(null);
      try {
        let items: VideoListItem[] = [];
        let resultTotal = 0;
        let resultHasMore = false;

        if (c.collection_type === "favorite") {
          // 收藏夹：get_favorite_videos → FavoriteMedia，适配成 VideoListItem
          const res = await invoke<FavoriteListResult>("get_favorite_videos", {
            mediaId: c.id,
            page,
          });
          items = res.medias.map((m: FavoriteMedia) => ({
            bvid: m.bvid,
            title: m.title,
            cover: m.cover,
            upper_name: m.upper_name,
            upper_mid: m.upper_mid,
            duration: m.duration ?? 0,
            play: m.play,
            danmaku: 0,
            pubdate: m.fav_time,
          }));
          resultTotal = res.total;
          resultHasMore = res.has_more;
        } else {
          // 合集：get_collection_videos
          const res = await invoke<PagedResult<VideoListItem>>(
            "get_collection_videos",
            { mid: c.upper_mid, sid: c.id, collectionType: "season", page }
          );
          items = res.items;
          resultTotal = res.total;
          resultHasMore = res.has_more;
        }

        setVideos((prev) => (append ? [...prev, ...items] : items));
        setVideoPage(page);
        setHasMore(resultHasMore);
        setTotal(resultTotal);
      } catch (e) {
        const msg = friendlyError(e);
        setVideoError(msg);
        toast.error(`加载内容失败：${msg}`);
      } finally {
        setLoadingVideos(false);
      }
    },
    [toast]
  );

  const handleSelectCollection = (c: SubscribedCollection) => {
    setSelected(c);
    setVideos([]);
    setSelectedBvids(new Set());
    setSelectMode(false);
    loadVideos(c, 1, false);
  };

  const handleBackToList = () => {
    setSelected(null);
    setVideos([]);
  };

  const handleSelectVideo = async (item: VideoListItem) => {
    if (parsingBvid || !item.bvid) return;
    setParsingBvid(item.bvid);
    try {
      const videoInfo = await onParseVideo(
        `https://www.bilibili.com/video/${item.bvid}`
      );
      onSelectItem(videoInfo);
    } catch {
      // 上层处理
    } finally {
      setParsingBvid(null);
    }
  };

  const toggleSelect = (bvid: string) => {
    setSelectedBvids((prev) => {
      const next = new Set(prev);
      if (next.has(bvid)) next.delete(bvid);
      else next.add(bvid);
      return next;
    });
  };

  const downloadSelected = async () => {
    if (!onBatchDownload || selectedBvids.size === 0 || !selected) return;
    setBatchBusy(true);
    try {
      await onBatchDownload([...selectedBvids], selected.name);
      setSelectedBvids(new Set());
      setSelectMode(false);
    } finally {
      setBatchBusy(false);
    }
  };

  // 订阅追更：添加后按当前内容为基线，只追新增
  const handleSubscribe = async (c: SubscribedCollection) => {
    const key = `${c.collection_type}-${c.id}`;
    try {
      await invoke("add_subscription", {
        kind: c.collection_type,
        sourceId: c.id,
        title: c.name,
        cover: c.cover,
        upperName: c.upper_name,
        upperMid: c.upper_mid,
      });
      setSubscribedKey(key);
      toast.success(`已订阅「${c.name}」追更：新内容将自动下载`);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  // ===== 视频详情层 =====
  if (selected) {
    const colKey = `${selected.collection_type}-${selected.id}`;
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={handleBackToList}
            className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <h2 className="text-sm font-semibold text-ink-2 truncate">
            {selected.name}
          </h2>
          <span className="text-xs text-ink-3">{total} 个内容</span>
          <button
            onClick={() => handleSubscribe(selected)}
            disabled={subscribedKey === colKey}
            className={subscribedKey === colKey
              ? "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-green-200 text-green-600 bg-green-50"
              : "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-line text-ink-3 hover:text-accent hover:border-accent transition-colors"}
          >
            {subscribedKey === colKey ? <Check size={12} /> : <Bell size={12} />}
            {subscribedKey === colKey ? "已订阅追更" : "订阅追更"}
          </button>
        </div>

        {onBatchDownload && videos.length > 0 && (
          <BatchBar
            selectMode={selectMode}
            onToggleMode={() => setSelectMode((v) => !v)}
            selectedCount={selectedBvids.size}
            totalCount={videos.length}
            onSelectAll={() => setSelectedBvids(new Set(videos.filter((v) => v.bvid).map((v) => v.bvid)))}
            onClearSelection={() => setSelectedBvids(new Set())}
            onDownloadSelected={downloadSelected}
            busy={batchBusy}
          />
        )}

        {videoError && videos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <AlertCircle size={20} />
            <p className="text-sm">{videoError}</p>
            <button
              onClick={() => loadVideos(selected, 1, false)}
              className="text-xs text-blue-500 hover:underline"
            >
              重试
            </button>
          </div>
        ) : videos.length === 0 && !loadingVideos ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <Bookmark size={40} strokeWidth={1.5} />
            <p className="text-sm">暂无内容</p>
          </div>
        ) : (
          <div className="space-y-2">
            {videos.map((item) => (
              <VideoCard
                key={item.bvid || item.title}
                title={item.title}
                cover={item.cover}
                upperName={item.upper_name}
                duration={item.duration}
                play={item.play}
                danmaku={item.danmaku}
                pubdate={item.pubdate}
                loading={!selectMode && parsingBvid === item.bvid}
                disabled={!item.bvid}
                onClick={() => handleSelectVideo(item)}
                selectMode={selectMode}
                selected={!!item.bvid && selectedBvids.has(item.bvid)}
                onToggleSelect={() => item.bvid && toggleSelect(item.bvid)}
              />
            ))}

            {hasMore && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={() => loadVideos(selected, videoPage + 1, true)}
                  disabled={loadingVideos}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
                >
                  {loadingVideos ? (
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

            {loadingVideos && videos.length === 0 && (
              <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">加载中...</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ===== 订阅列表层 =====
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
          onClick={loadCollections}
          className="text-xs text-blue-500 hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  if (collections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
        <Bookmark size={40} strokeWidth={1.5} />
        <p className="text-sm">暂无订阅的合集/收藏夹</p>
      </div>
    );
  }

  return (
    <div>
      {/* 本地追更订阅管理（有订阅才显示） */}
      <SubscriptionManager />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {collections.map((c) => {
          const isFavorite = c.collection_type === "favorite";
          const key = `${c.collection_type}-${c.id}`;
          return (
            <div
              key={key}
              className="flex items-start gap-3 px-4 py-3 bg-panel border border-line rounded-lg hover:border-line-2 transition-colors text-left"
            >
              <button
                onClick={() => handleSelectCollection(c)}
                className="flex items-start gap-3 flex-1 min-w-0 text-left"
              >
                {isFavorite ? (
                  <Bookmark size={20} className="text-yellow-500 shrink-0 mt-0.5" />
                ) : (
                  <Layers size={20} className="text-green-500 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink-2 line-clamp-1">
                    {c.name}
                  </p>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {c.total} 个内容
                  </p>
                  {c.upper_name && (
                    <p className="text-xs text-ink-3 mt-0.5 truncate">
                      UP: {c.upper_name}
                    </p>
                  )}
                </div>
                <span className="text-[10px] text-ink-3 shrink-0">
                  {isFavorite ? "收藏夹" : "合集"}
                </span>
              </button>
              {/* 订阅追更按钮 */}
              <button
                onClick={() => handleSubscribe(c)}
                disabled={subscribedKey === key}
                title="订阅追更：新内容自动下载"
                className={
                  subscribedKey === key
                    ? "p-1.5 rounded-lg text-green-500 bg-green-50 shrink-0"
                    : "p-1.5 rounded-lg text-ink-3 hover:text-blue-500 hover:bg-blue-50 transition-colors shrink-0"
                }
              >
                {subscribedKey === key ? <Check size={14} /> : <Bell size={14} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
