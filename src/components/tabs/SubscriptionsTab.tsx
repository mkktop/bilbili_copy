import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  Bookmark,
  Layers,
  ArrowLeft,
} from "lucide-react";
import type {
  SubscribedCollection,
  VideoListItem,
  PagedResult,
  FavoriteMedia,
  FavoriteListResult,
  ParsedVideoInfo,
} from "../../types";
import { VideoCard } from "../VideoCard";
import { useToast } from "../Toast";
import { friendlyError } from "../../lib/errors";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function SubscriptionsTab({ onParseVideo, onSelectItem }: Props) {
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

  // ===== 视频详情层 =====
  if (selected) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={handleBackToList}
            className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <h2 className="text-sm font-semibold text-gray-700 truncate">
            {selected.name}
          </h2>
          <span className="text-xs text-gray-400">{total} 个内容</span>
        </div>

        {videoError && videos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
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
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
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
                loading={parsingBvid === item.bvid}
                disabled={!item.bvid}
                onClick={() => handleSelectVideo(item)}
              />
            ))}

            {hasMore && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={() => loadVideos(selected, videoPage + 1, true)}
                  disabled={loadingVideos}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
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
              <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
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
      <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
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
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
        <Bookmark size={40} strokeWidth={1.5} />
        <p className="text-sm">暂无订阅的合集/收藏夹</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {collections.map((c) => {
        const isFavorite = c.collection_type === "favorite";
        return (
          <button
            key={`${c.collection_type}-${c.id}`}
            onClick={() => handleSelectCollection(c)}
            className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left"
          >
            {isFavorite ? (
              <Bookmark size={20} className="text-yellow-500 shrink-0 mt-0.5" />
            ) : (
              <Layers size={20} className="text-green-500 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-700 line-clamp-1">
                {c.name}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {c.total} 个内容
              </p>
              {c.upper_name && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  UP: {c.upper_name}
                </p>
              )}
            </div>
            <span className="text-[10px] text-gray-400 shrink-0">
              {isFavorite ? "收藏夹" : "合集"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
