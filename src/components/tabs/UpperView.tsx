import { useState, useEffect, useCallback, type RefObject } from "react";
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
  Download,
  Bell,
  Check,
} from "lucide-react";
import type {
  UpperInfo,
  VideoListItem,
  PagedResult,
  CollectionInfo,
  FollowingItem,
  ParsedVideoInfo,
} from "../../types";
import { VideoCard, formatCount } from "../VideoCard";
import { BatchBar } from "../BatchBar";
import { VirtualList } from "../VirtualList";
import { useToast } from "../Toast";
import { friendlyError } from "../../lib/errors";

interface Props {
  mid: number;
  /** 虚拟化列表的外层滚动容器 ref（来自 UserProfilePage 的 flex-1 overflow-auto） */
  scrollRef: RefObject<HTMLElement | null>;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载已选视频（投稿/合集列表多选场景） */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
}

export function UpperView({ mid, scrollRef, onParseVideo, onSelectItem, onBatchDownload }: Props) {
  const [upper, setUpper] = useState<UpperInfo | null>(null);
  const [loadingUpper, setLoadingUpper] = useState(true);
  const [upperError, setUpperError] = useState<string | null>(null);

  const [tab, setTab] = useState<"submission" | "collection" | "followers">("submission");

  // 投稿
  const [submissions, setSubmissions] = useState<VideoListItem[]>([]);
  const [subPage, setSubPage] = useState(1);
  const [subHasMore, setSubHasMore] = useState(false);
  const [subTotal, setSubTotal] = useState(0);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  // 合集
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loadingCols, setLoadingCols] = useState(false);
  const [colsLoaded, setColsLoaded] = useState(false);
  const [colsError, setColsError] = useState<string | null>(null);
  const [selectedCol, setSelectedCol] = useState<CollectionInfo | null>(null);
  const [colVideos, setColVideos] = useState<VideoListItem[]>([]);
  const [colPage, setColPage] = useState(1);
  const [colHasMore, setColHasMore] = useState(false);
  const [colTotal, setColTotal] = useState(0);
  const [loadingColVideos, setLoadingColVideos] = useState(false);
  const [colVideoError, setColVideoError] = useState<string | null>(null);

  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  // 粉丝列表（UP 主主页第三 tab）
  const [followers, setFollowers] = useState<FollowingItem[]>([]);
  const [followersTotal, setFollowersTotal] = useState(0);
  const [followersPage, setFollowersPage] = useState(1);
  const [followersMore, setFollowersMore] = useState(false);
  const [loadingFollowers, setLoadingFollowers] = useState(false);

  // 批量下载选择状态（投稿列表 / 合集详情共用）
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 当前合集是否已订阅追更（本次会话内记忆，避免重复添加报错）
  const [subscribedCol, setSubscribedCol] = useState<string | null>(null);

  const toast = useToast();

  const toggleSelect = (bvid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bvid)) next.delete(bvid);
      else next.add(bvid);
      return next;
    });
  };

  // 批量下载已选视频（folder 指定下载目录分组）
  const downloadSelected = async (folder?: string) => {
    if (!onBatchDownload || selected.size === 0) return;
    setBatchBusy(true);
    try {
      await onBatchDownload([...selected], folder);
      setSelected(new Set());
      setSelectMode(false);
    } finally {
      setBatchBusy(false);
    }
  };

  // 订阅合集追更：只追新增内容（历史内容用批量下载）
  const handleSubscribeCol = async (c: CollectionInfo) => {
    try {
      await invoke("add_subscription", {
        kind: c.collection_type,
        sourceId: c.id,
        title: c.name,
        cover: c.cover,
        upperName: upper?.name ?? "",
        upperMid: c.mid,
      });
      setSubscribedCol(`${c.collection_type}-${c.id}`);
      toast.success(`已订阅「${c.name}」追更：新内容将自动下载`);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  // 粉丝列表分页加载
  const loadFollowers = useCallback(
    async (page: number, append: boolean) => {
      setLoadingFollowers(true);
      try {
        const res = await invoke<PagedResult<FollowingItem>>("get_followers", { mid, page });
        setFollowers((prev) => (append ? [...prev, ...res.items] : res.items));
        setFollowersPage(page);
        setFollowersTotal(res.total);
        setFollowersMore(res.has_more);
      } catch (e) {
        toast.error(`加载粉丝列表失败：${friendlyError(e)}`);
      } finally {
        setLoadingFollowers(false);
      }
    },
    [mid, toast]
  );

  useEffect(() => {
    if (tab === "followers" && followers.length === 0 && !loadingFollowers) {
      loadFollowers(1, false);
    }
  }, [tab, followers.length, loadingFollowers, loadFollowers]);

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
        if (!cancelled) setUpperError(friendlyError(e));
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
      if (!append) setSubError(null);
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
        const msg = friendlyError(e);
        setSubError(msg);
        toast.error(`加载投稿失败：${msg}`);
      } finally {
        setLoadingSubs(false);
      }
    },
    [mid, toast]
  );

  useEffect(() => {
    loadSubmissions(1, false);
  }, [loadSubmissions]);

  // 合集列表（切到 collection tab 时懒加载一次）
  const loadCollections = useCallback(async () => {
    if (colsLoaded || loadingCols) return;
    setLoadingCols(true);
    setColsError(null);
    try {
      const res = await invoke<CollectionInfo[]>("get_upper_collections", {
        mid,
      });
      setCollections(res);
    } catch (e) {
      const msg = friendlyError(e);
      setColsError(msg);
      toast.error(`加载合集失败：${msg}`);
    } finally {
      setLoadingCols(false);
      setColsLoaded(true);
    }
  }, [mid, colsLoaded, loadingCols, toast]);

  useEffect(() => {
    if (tab === "collection" && !selectedCol) loadCollections();
  }, [tab, selectedCol, loadCollections]);

  const loadCollectionVideos = useCallback(
    async (c: CollectionInfo, page: number, append: boolean) => {
      setLoadingColVideos(true);
      if (!append) setColVideoError(null);
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
        const msg = friendlyError(e);
        setColVideoError(msg);
        toast.error(`加载合集视频失败：${msg}`);
      } finally {
        setLoadingColVideos(false);
      }
    },
    [mid, toast]
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
    const colKey = `${selectedCol.collection_type}-${selectedCol.id}`;
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => { setSelectedCol(null); setSelected(new Set()); setSelectMode(false); }}
            className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
          <h2 className="text-sm font-semibold text-ink-2 truncate">
            {selectedCol.name}
          </h2>
          <span className="text-xs text-ink-3">{colTotal} 个视频</span>
          {/* 订阅追更：定时检查新内容并自动下载 */}
          <button
            onClick={() => handleSubscribeCol(selectedCol)}
            disabled={subscribedCol === colKey}
            className={subscribedCol === colKey
              ? "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-green-200 text-green-600 bg-green-50"
              : "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-line text-ink-3 hover:text-accent hover:border-accent transition-colors"}
          >
            {subscribedCol === colKey ? <Check size={12} /> : <Bell size={12} />}
            {subscribedCol === colKey ? "已订阅追更" : "订阅追更"}
          </button>
        </div>

        {onBatchDownload && colVideos.length > 0 && (
          <BatchBar
            selectMode={selectMode}
            onToggleMode={() => setSelectMode((v) => !v)}
            selectedCount={selected.size}
            totalCount={colVideos.length}
            onSelectAll={() => setSelected(new Set(colVideos.filter((v) => v.bvid).map((v) => v.bvid)))}
            onClearSelection={() => setSelected(new Set())}
            onDownloadSelected={() => downloadSelected(selectedCol.name)}
            busy={batchBusy}
          />
        )}

        {colVideoError && colVideos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <AlertCircle size={20} />
            <p className="text-sm">{colVideoError}</p>
            <button
              onClick={() => loadCollectionVideos(selectedCol, 1, false)}
              className="text-xs text-blue-500 hover:underline"
            >
              重试
            </button>
          </div>
        ) : colVideos.length === 0 && !loadingColVideos ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <Layers size={40} strokeWidth={1.5} />
            <p className="text-sm">合集中暂无视频</p>
          </div>
        ) : (
          <div className="space-y-2">
            <VirtualList
              items={colVideos}
              scrollRef={scrollRef}
              estimateSize={96}
              gap={8}
              onNearEnd={() => {
                if (colHasMore && !loadingColVideos && selectedCol) {
                  loadCollectionVideos(selectedCol, colPage + 1, true);
                }
              }}
              renderItem={(item) => (
                <VideoCard
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
                  selected={!!item.bvid && selected.has(item.bvid)}
                  onToggleSelect={() => item.bvid && toggleSelect(item.bvid)}
                />
              )}
            />
            {colHasMore && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={() =>
                    loadCollectionVideos(selectedCol, colPage + 1, true)
                  }
                  disabled={loadingColVideos}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
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
        <div className="flex items-center justify-center py-6 text-ink-3 gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">加载 UP 主信息...</span>
        </div>
      ) : upperError ? (
        <div className="flex items-center gap-2 px-4 py-3 mb-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={14} />
          {upperError}
        </div>
      ) : upper ? (
        <div className="px-4 py-4 bg-panel border border-line rounded-lg mb-4">
          <div className="flex items-center gap-4">
            <img
              src={upper.face}
              alt={upper.name}
              className="w-14 h-14 rounded-full object-cover border border-line"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-ink truncate">
                  {upper.name}
                </p>
                <span className="flex items-center gap-0.5 text-xs text-ink-3">
                  <Crown size={12} className="text-yellow-500" />
                  Lv.{upper.level}
                </span>
              </div>
              <p className="text-xs text-ink-3 mt-0.5">UID: {upper.mid}</p>
              {upper.sign && (
                <p className="text-xs text-ink-3 mt-1 line-clamp-1">
                  {upper.sign}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-line">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-ink-2">
                <Film size={12} className="text-blue-500" />
                {upper.archive_count}
              </div>
              <p className="text-xs text-ink-3 mt-0.5">投稿</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-ink-2">
                <Users size={12} className="text-pink-500" />
                {formatCount(upper.fans)}
              </div>
              <p className="text-xs text-ink-3 mt-0.5">粉丝</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-semibold text-ink-2">
                <Users size={12} className="text-blue-500" />
                {formatCount(upper.following)}
              </div>
              <p className="text-xs text-ink-3 mt-0.5">关注</p>
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
              : "bg-panel border-line text-ink-3 hover:bg-panel-2"
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
              : "bg-panel border-line text-ink-3 hover:bg-panel-2"
          }`}
        >
          <Layers size={14} />
          合集/列表
        </button>
        <button
          onClick={() => setTab("followers")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            tab === "followers"
              ? "bg-blue-50 border-blue-300 text-blue-600"
              : "bg-panel border-line text-ink-3 hover:bg-panel-2"
          }`}
        >
          <Users size={14} />
          粉丝 {upper && upper.fans > 0 && `(${formatCount(upper.fans)})`}
        </button>
      </div>

      {/* 投稿列表 */}
      {tab === "submission" && (
        <div className="space-y-2">
          {subError && submissions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <AlertCircle size={20} />
              <p className="text-sm">{subError}</p>
              <button
                onClick={() => loadSubmissions(1, false)}
                className="text-xs text-blue-500 hover:underline"
              >
                重试
              </button>
            </div>
          ) : submissions.length === 0 && !loadingSubs ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <ListVideo size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无投稿</p>
            </div>
          ) : (
            <>
              {onBatchDownload && (
                <BatchBar
                  selectMode={selectMode}
                  onToggleMode={() => setSelectMode((v) => !v)}
                  selectedCount={selected.size}
                  totalCount={submissions.length}
                  onSelectAll={() => setSelected(new Set(submissions.filter((v) => v.bvid).map((v) => v.bvid)))}
                  onClearSelection={() => setSelected(new Set())}
                  onDownloadSelected={() => downloadSelected(upper?.name)}
                  busy={batchBusy}
                />
              )}
              <VirtualList
                items={submissions}
                scrollRef={scrollRef}
                estimateSize={96}
                gap={8}
                onNearEnd={() => {
                  if (subHasMore && !loadingSubs) loadSubmissions(subPage + 1, true);
                }}
                renderItem={(item) => (
                  <VideoCard
                    title={item.title}
                    cover={item.cover}
                    duration={item.duration}
                    play={item.play}
                    danmaku={item.danmaku}
                    pubdate={item.pubdate}
                    loading={!selectMode && parsingBvid === item.bvid}
                    disabled={!item.bvid}
                    onClick={() => handleSelectVideo(item)}
                    selectMode={selectMode}
                    selected={!!item.bvid && selected.has(item.bvid)}
                    onToggleSelect={() => item.bvid && toggleSelect(item.bvid)}
                  />
                )}
              />
              {subHasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    onClick={() => loadSubmissions(subPage + 1, true)}
                    disabled={loadingSubs}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
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
            <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : colsError && collections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <AlertCircle size={20} />
              <p className="text-sm">{colsError}</p>
              <button
                onClick={() => {
                  setColsLoaded(false);
                  loadCollections();
                }}
                className="text-xs text-blue-500 hover:underline"
              >
                重试
              </button>
            </div>
          ) : collections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <Layers size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无合集/列表</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {collections.map((c) => (
                <button
                  key={`${c.collection_type}-${c.id}`}
                  onClick={() => handleSelectCollection(c)}
                  className="flex items-start gap-3 px-4 py-3 bg-panel border border-line rounded-lg hover:bg-panel-2 hover:border-line-2 transition-colors text-left"
                >
                  {c.cover ? (
                    <img
                      src={c.cover}
                      alt={c.name}
                      className="w-14 h-14 rounded object-cover shrink-0 bg-panel-2"
                    />
                  ) : (
                    <Layers size={20} className="text-green-500 shrink-0 mt-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-2 line-clamp-2">
                      {c.name}
                    </p>
                    <p className="text-xs text-ink-3 mt-0.5">
                      {c.total} 个视频 · {c.collection_type === "season" ? "合集" : "列表"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 粉丝列表 */}
      {tab === "followers" && (
        <div>
          {loadingFollowers && followers.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">加载粉丝列表...</span>
            </div>
          ) : followers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <Users size={40} strokeWidth={1.5} />
              <p className="text-sm">暂无粉丝数据</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-ink-3 mb-2">共 {formatCount(followersTotal)} 位粉丝</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {followers.map((f) => (
                  <div
                    key={f.mid}
                    className="flex items-center gap-3 px-3 py-2.5 bg-panel border border-line rounded-lg"
                  >
                    <img
                      src={f.face}
                      alt={f.name}
                      className="w-9 h-9 rounded-full object-cover bg-panel-2 shrink-0"
                      loading="lazy"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-2 truncate">{f.name}</p>
                      {f.sign && (
                        <p className="text-xs text-ink-3 truncate mt-0.5">{f.sign}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {followersMore && (
                <div className="flex justify-center pt-3">
                  <button
                    onClick={() => loadFollowers(followersPage + 1, true)}
                    disabled={loadingFollowers}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
                  >
                    {loadingFollowers ? (
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
    </div>
  );
}
