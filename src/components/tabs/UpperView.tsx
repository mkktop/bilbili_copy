import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  AlertCircle,
  Layers,
  ListVideo,
  Crown,
  Users,
  Film,
  ArrowLeft,
} from "lucide-react";
import type {
  UpperInfo,
  VideoListItem,
  PagedResult,
  CollectionInfo,
  ParsedVideoInfo,
} from "../../types";
import { VideoCard, formatCount } from "../VideoCard";

interface Props {
  mid: number;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function UpperView({ mid, onParseVideo, onSelectItem }: Props) {
  const [upper, setUpper] = useState<UpperInfo | null>(null);
  const [loadingUpper, setLoadingUpper] = useState(true);
  const [upperError, setUpperError] = useState<string | null>(null);

  const [tab, setTab] = useState<"submission" | "collection">("submission");

  // 投稿
  const [submissions, setSubmissions] = useState<VideoListItem[]>([]);
  const [subPage, setSubPage] = useState(1);
  const [subHasMore, setSubHasMore] = useState(false);
  const [subTotal, setSubTotal] = useState(0);
  const [loadingSubs, setLoadingSubs] = useState(false);

  // 合集
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loadingCols, setLoadingCols] = useState(false);
  const [colsLoaded, setColsLoaded] = useState(false);
  const [selectedCol, setSelectedCol] = useState<CollectionInfo | null>(null);
  const [colVideos, setColVideos] = useState<VideoListItem[]>([]);
  const [colPage, setColPage] = useState(1);
  const [colHasMore, setColHasMore] = useState(false);
  const [colTotal, setColTotal] = useState(0);
  const [loadingColVideos, setLoadingColVideos] = useState(false);

  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  // 加载 UP 主信息
  useEffect(() => {
    let cancelled = false;
    setLoadingUpper(true);
    setUpperError(null);
    invoke<UpperInfo>("get_upper_info", { mid })
      .then((info) => {
        if (!cancelled) setUpper(info);
      })
      .catch((e) => {
        if (!cancelled) setUpperError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingUpper(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mid]);

  // 投稿列表（首页或加载更多）
  const loadSubmissions = useCallback(
    async (page: number, append: boolean) => {
      setLoadingSubs(true);
      try {
        const res = await invoke<PagedResult<VideoListItem>>(
          "get_submission_videos",
          { mid, page }
        );
        setSubmissions((prev) => (append ? [...prev, ...res.items] : res.items));
        setSubPage(page);
        setSubHasMore(res.has_more);
        setSubTotal(res.total);
      } catch (e) {
        console.error("加载投稿失败:", e);
      } finally {
        setLoadingSubs(false);
      }
    },
    [mid]
  );

  useEffect(() => {
    loadSubmissions(1, false);
  }, [loadSubmissions]);

  // 合集列表（切到 collection tab 时懒加载一次）
  const loadCollections = useCallback(async () => {
    if (colsLoaded || loadingCols) return;
    setLoadingCols(true);
    try {
      const res = await invoke<CollectionInfo[]>("get_upper_collections", {
        mid,
      });
      setCollections(res);
    } catch (e) {
      console.error("加载合集失败:", e);
    } finally {
      setLoadingCols(false);
      setColsLoaded(true);
    }
  }, [mid, colsLoaded, loadingCols]);

  useEffect(() => {
    if (tab === "collection" && !selectedCol) loadCollections();
  }, [tab, selectedCol, loadCollections]);

  const loadCollectionVideos = useCallback(
    async (c: CollectionInfo, page: number, append: boolean) => {
      setLoadingColVideos(true);
      try {
        const res = await invoke<PagedResult<VideoListItem>>(
          "get_collection_videos",
          { mid, sid: c.id, collectionType: c.collection_type, page }
        );
        setColVideos((prev) => (append ? [...prev, ...res.items] : res.items));
        setColPage(page);
        setColHasMore(res.has_more);
        setColTotal(res.total);
      } catch (e) {
        console.error("加载合集视频失败:", e);
      } finally {
        setLoadingColVideos(false);
      }
    },
    [mid]
  );

  const handleSelectCollection = (c: CollectionInfo) => {
    setSelectedCol(c);
    setColVideos([]);
    loadCollectionVideos(c, 1, false);
  };

  const handleSelectVideo = async (item: VideoListItem) => {
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

  // ===== 合集视频详情层 =====
  if (selectedCol) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setSelectedCol(null)}
            className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <h2 className="text-sm font-semibold text-gray-700 truncate">
            {selectedCol.name}
          </h2>
          <span className="text-xs text-gray-400">{colTotal} 个视频</span>
        </div>

        {colVideos.length === 0 && !loadingColVideos ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <Layers size={40} strokeWidth={1.5} />
            <p className="text-sm">合集中暂无视频</p>
          </div>
        ) : (
          <div className="space-y-2">
            {colVideos.map((item) => (
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
            {colHasMore && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={() =>
                    loadCollectionVideos(selectedCol, colPage + 1, true)
                  }
                  disabled={loadingColVideos}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  {loadingColVideos ? (
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
          </div>
        )}
      </div>
    );
  }

  // ===== UP 主主页：信息卡 + 投稿/合集 =====
  return (
    <div>
      {/* UP 主信息卡 */}
      {loadingUpper ? (
        <div className="flex items-center justify-center py-6 text-gray-400 gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">加载 UP 主信息...</span>
        </div>
      ) : upperError ? (
        <div className="flex items-center gap-2 px-4 py-3 mb-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={14} />
          {upperError}
        </div>
      ) : upper ? (
        <div className="px-4 py-4 bg-white border border-gray-200 rounded-lg mb-4">
          <div className="flex items-center gap-4">
            <img
              src={upper.face}
              alt={upper.name}
              className="w-14 h-14 rounded-full object-cover border border-gray-200"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-gray-800 truncate">
                  {upper.name}
                </p>
                <span className="flex items-center gap-0.5 text-xs text-gray-400">
                  <Crown size={12} className="text-yellow-500" />
                  Lv.{upper.level}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">UID: {upper.mid}</p>
              {upper.sign && (
                <p className="text-xs text-gray-400 mt-1 line-clamp-1">
                  {upper.sign}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-gray-100">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-gray-700">
                <Film size={12} className="text-blue-500" />
                {upper.archive_count}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">投稿</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-gray-700">
                <Users size={12} className="text-pink-500" />
                {formatCount(upper.fans)}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">粉丝</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-gray-700">
                <Users size={12} className="text-blue-500" />
                {formatCount(upper.following)}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">关注</p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 投稿/合集 Tab */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setTab("submission")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            tab === "submission"
              ? "bg-blue-50 border-blue-300 text-blue-600"
              : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
          }`}
        >
          <ListVideo size={14} />
          投稿 {subTotal > 0 && `(${subTotal})`}
        </button>
        <button
          onClick={() => setTab("collection")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            tab === "collection"
              ? "bg-blue-50 border-blue-300 text-blue-600"
              : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
          }`}
        >
          <Layers size={14} />
          合集/列表
        </button>
      </div>

      {/* 投稿列表 */}
      {tab === "submission" && (
        <div className="space-y-2">
          {submissions.length === 0 && !loadingSubs ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
              <ListVideo size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无投稿</p>
            </div>
          ) : (
            <>
              {submissions.map((item) => (
                <VideoCard
                  key={item.bvid || item.title}
                  title={item.title}
                  cover={item.cover}
                  duration={item.duration}
                  play={item.play}
                  danmaku={item.danmaku}
                  pubdate={item.pubdate}
                  loading={parsingBvid === item.bvid}
                  disabled={!item.bvid}
                  onClick={() => handleSelectVideo(item)}
                />
              ))}
              {subHasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    onClick={() => loadSubmissions(subPage + 1, true)}
                    disabled={loadingSubs}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {loadingSubs ? (
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
            </>
          )}
        </div>
      )}

      {/* 合集列表 */}
      {tab === "collection" && (
        <div>
          {loadingCols ? (
            <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : collections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
              <Layers size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无合集/列表</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {collections.map((c) => (
                <button
                  key={`${c.collection_type}-${c.id}`}
                  onClick={() => handleSelectCollection(c)}
                  className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left"
                >
                  {c.cover ? (
                    <img
                      src={c.cover}
                      alt={c.name}
                      className="w-14 h-14 rounded object-cover shrink-0 bg-gray-100"
                    />
                  ) : (
                    <Layers size={20} className="text-green-500 shrink-0 mt-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-700 line-clamp-2">
                      {c.name}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {c.total} 个视频 · {c.collection_type === "season" ? "合集" : "列表"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
