import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  LogOut,
  FolderOpen,
  Loader2,
  ChevronDown,
  User,
  Clock,
  AlertCircle,
  Star,
  Coins,
  Users,
  Eye,
  ThumbsUp,
  Crown,
  Bookmark,
  History,
  Tv,
  Bell,
  Check,
} from "lucide-react";
import type { UserInfo } from "../hooks/useLogin";
import { WatchLaterTab } from "./tabs/WatchLaterTab";
import { WatchHistoryTab } from "./tabs/WatchHistoryTab";
import { SubscriptionsTab } from "./tabs/SubscriptionsTab";
import { BangumiTab } from "./tabs/BangumiTab";
import { FollowingsTab } from "./tabs/FollowingsTab";
import { UpperView } from "./tabs/UpperView";
import { BatchBar } from "./BatchBar";
import { formatCount } from "./VideoCard";
import { VirtualList } from "./VirtualList";
import { useToast } from "./Toast";
import { friendlyError } from "../lib/errors";
import type {
  FavoriteFolder,
  FavoriteMedia,
  FavoriteListResult,
  ParsedVideoInfo,
} from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";

interface UserProfilePageProps {
  userInfo: UserInfo;
  onLogout: () => Promise<void>;
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载（收藏夹/稍后再看/订阅列表/UP投稿多选） */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
  /** 整季批量下载（追番/追剧） */
  onBatchDownloadSeason?: (seasonId: number, title: string) => Promise<void>;
}

export function UserProfilePage({
  userInfo,
  onLogout,
  onBack,
  onParseVideo,
  onSelectItem,
  onBatchDownload,
  onBatchDownloadSeason,
}: UserProfilePageProps) {
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [folderError, setFolderError] = useState<string | null>(null);

  // 当前选中的收藏夹
  const [selectedFolder, setSelectedFolder] = useState<FavoriteFolder | null>(
    null
  );
  const [medias, setMedias] = useState<FavoriteMedia[]>([]);
  const [loadingMedias, setLoadingMedias] = useState(false);
  const [mediaPage, setMediaPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [mediaTotal, setMediaTotal] = useState(0);

  // 虚拟化列表的外层滚动容器 ref（flex-1 overflow-auto）。
  // 收藏夹内容 / UP 主投稿等长列表通过它做窗口化渲染。
  const scrollRef = useRef<HTMLDivElement>(null);

  // 解析状态
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  const [loggingOut, setLoggingOut] = useState(false);

  // 我的关注 tab 中选中的 UP 主 mid（null = 关注列表，非 null = 该 UP 主主页）
  const [selectedUpperMid, setSelectedUpperMid] = useState<number | null>(null);

  // 收藏夹详情的批量下载选择
  const [favSelectMode, setFavSelectMode] = useState(false);
  const [favSelected, setFavSelected] = useState<Set<string>>(new Set());
  const [favBatchBusy, setFavBatchBusy] = useState(false);
  // 已订阅追更的收藏夹 key（本次会话内记忆）
  const [subscribedFolder, setSubscribedFolder] = useState<number | null>(null);

  // Tab 切换：收藏夹 / 观看历史 / 稍后再看 / 我的关注 / 我的订阅 / 追番追剧
  const [tab, setTab] = useState<
    "favorites" | "history" | "watch_later" | "followings" | "subscriptions" | "bangumi"
  >("favorites");

  const toast = useToast();

  const handleSetTab = (t: typeof tab) => {
    setTab(t);
    setSelectedFolder(null);
    setMedias([]);
    setSelectedUpperMid(null);
  };

  // 加载收藏夹列表
  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    setFolderError(null);
    try {
      const result = await invoke<FavoriteFolder[]>("get_favorite_folders");
      setFolders(result);
    } catch (e) {
      setFolderError(friendlyError(e));
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // 加载收藏夹视频（首页或加载更多）
  const loadMedias = useCallback(
    async (folder: FavoriteFolder, page: number, append: boolean) => {
      setLoadingMedias(true);
      try {
        const result = await invoke<FavoriteListResult>("get_favorite_videos", {
          mediaId: folder.id.toString(),
          page,
        });
        if (append) {
          setMedias((prev) => [...prev, ...result.medias]);
        } else {
          setMedias(result.medias);
        }
        setMediaPage(page);
        setHasMore(result.has_more);
        setMediaTotal(result.total);
      } catch (e) {
        toast.error(`加载收藏夹视频失败：${friendlyError(e)}`);
      } finally {
        setLoadingMedias(false);
      }
    },
    [toast]
  );

  // 点击收藏夹
  const handleSelectFolder = (folder: FavoriteFolder) => {
    setSelectedFolder(folder);
    setMedias([]);
    setMediaPage(1);
    setFavSelected(new Set());
    setFavSelectMode(false);
    loadMedias(folder, 1, false);
  };

  // 返回收藏夹列表
  const handleBackToFolders = () => {
    setSelectedFolder(null);
    setMedias([]);
    setFavSelected(new Set());
    setFavSelectMode(false);
  };

  // 收藏夹批量下载已选视频
  const downloadFavSelected = async () => {
    if (!onBatchDownload || favSelected.size === 0 || !selectedFolder) return;
    setFavBatchBusy(true);
    try {
      await onBatchDownload([...favSelected], selectedFolder.title);
      setFavSelected(new Set());
      setFavSelectMode(false);
    } finally {
      setFavBatchBusy(false);
    }
  };

  // 订阅收藏夹追更（收藏夹有新增时自动下载）
  const handleSubscribeFolder = async (folder: FavoriteFolder) => {
    try {
      await invoke("add_subscription", {
        kind: "favorite",
        sourceId: folder.id.toString(),
        title: folder.title,
        cover: "",
        upperName: userInfo.uname,
        upperMid: userInfo.mid,
      });
      setSubscribedFolder(folder.id);
      toast.success(`已订阅「${folder.title}」追更：新增收藏将自动下载`);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  // 点击视频：解析后跳转详情
  const handleSelectVideo = async (media: FavoriteMedia) => {
    if (parsingBvid) return;
    setParsingBvid(media.bvid);
    try {
      const url = `https://www.bilibili.com/video/${media.bvid}`;
      const videoInfo = await onParseVideo(url);
      onSelectItem(videoInfo);
    } catch {
      // 解析失败已在 handleParse 中处理
    } finally {
      setParsingBvid(null);
    }
  };

  // 退出登录
  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
      onBack();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      {/* 顶部标题栏 */}
      <header className="flex items-center gap-3 px-6 py-4 bg-panel border-b border-line">
        <button
          onClick={() => {
            if (selectedFolder) {
              handleBackToFolders();
            } else if (selectedUpperMid !== null) {
              setSelectedUpperMid(null);
            } else {
              onBack();
            }
          }}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-base transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">
          {selectedFolder
            ? selectedFolder.title
            : selectedUpperMid !== null
            ? "UP 主主页"
            : "个人主页"}
        </h1>
        {selectedFolder && (
          <span className="text-xs text-ink-3">
            {mediaTotal} 个视频
          </span>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
        {/* Tab 切换栏（收藏夹详情 / UP 主主页视图不显示） */}
        {!selectedFolder && selectedUpperMid === null && (
          <div className="flex gap-1 mb-4">
            {(
              [
                { key: "favorites", label: "收藏夹", Icon: FolderOpen },
                { key: "history", label: "观看历史", Icon: History },
                { key: "watch_later", label: "稍后再看", Icon: Clock },
                { key: "followings", label: "我的关注", Icon: Users },
                { key: "subscriptions", label: "我的订阅", Icon: Bookmark },
                { key: "bangumi", label: "追番追剧", Icon: Tv },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => handleSetTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  tab === key
                    ? "bg-blue-50 border-blue-300 text-blue-600"
                    : "bg-panel border-line text-ink-3 hover:bg-base"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        )}

        {/* 收藏夹列表视图 */}
        {!selectedFolder && tab === "favorites" && (
          <>
            {/* 用户信息卡片 */}
            <div className="px-4 py-5 bg-panel border border-line rounded-lg mb-4">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <img
                    src={userInfo.face}
                    alt={userInfo.uname}
                    className="w-16 h-16 rounded-full object-cover border border-line"
                  />
                  {userInfo.vip && (
                    <div className="absolute -bottom-1 -right-1 bg-yellow-400 rounded-full p-0.5">
                      <Crown size={10} className="text-white" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xl font-bold text-ink truncate">
                      {userInfo.uname}
                    </p>
                    <span className="text-xs text-ink-3">
                      {userInfo.sex === "男" ? "♂" : userInfo.sex === "女" ? "♀" : ""}
                    </span>
                  </div>
                  <p className="text-sm text-ink-3 mt-0.5">
                    UID: {userInfo.mid}
                  </p>
                  {userInfo.sign && (
                    <p className="text-xs text-ink-3 mt-1 truncate">
                      {userInfo.sign}
                    </p>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors shrink-0"
                >
                  <LogOut size={14} />
                  {loggingOut ? "退出中..." : "退出登录"}
                </button>
              </div>

              {/* 用户统计信息 */}
              <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-line">
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Star size={12} className="text-yellow-500" />
                    <span className="text-sm font-semibold text-ink-2">Lv.{userInfo.level}</span>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">等级</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Coins size={12} className="text-orange-500" />
                    <span className="text-sm font-semibold text-ink-2">{Math.floor(userInfo.coins)}</span>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">硬币</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Users size={12} className="text-blue-500" />
                    <span className="text-sm font-semibold text-ink-2">{formatCount(userInfo.following)}</span>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">关注</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Users size={12} className="text-pink-500" />
                    <span className="text-sm font-semibold text-ink-2">{formatCount(userInfo.follower)}</span>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">粉丝</p>
                </div>
              </div>
            </div>

            {/* 收藏夹列表 */}
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen size={16} className="text-ink-3" />
              <h2 className="text-sm font-semibold text-ink-2">我的收藏夹</h2>
            </div>

            {loadingFolders ? (
              <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">加载中...</span>
              </div>
            ) : folderError ? (
              <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
                <AlertCircle size={20} />
                <p className="text-sm">{folderError}</p>
                <button
                  onClick={loadFolders}
                  className="text-xs text-blue-500 hover:underline"
                >
                  重试
                </button>
              </div>
            ) : folders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
                <FolderOpen size={40} strokeWidth={1.5} />
                <p className="text-sm">暂无收藏夹</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {folders.map((folder) => (
                  <div
                    key={folder.id}
                    className="flex items-center gap-1 px-4 py-3 bg-panel border border-line rounded-lg hover:border-line-2 transition-colors"
                  >
                    <button
                      onClick={() => handleSelectFolder(folder)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <FolderOpen
                        size={20}
                        className="text-yellow-500 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink-2 truncate">
                          {folder.title}
                        </p>
                        <p className="text-xs text-ink-3">
                          {folder.media_count} 个视频
                        </p>
                      </div>
                      <ChevronDown
                        size={14}
                        className="text-ink-3 -rotate-90 shrink-0"
                      />
                    </button>
                    {/* 订阅追更：收藏夹新增内容自动下载 */}
                    <button
                      onClick={() => handleSubscribeFolder(folder)}
                      disabled={subscribedFolder === folder.id}
                      title="订阅追更：新增收藏自动下载"
                      className={cn(
                        "p-1.5 rounded-lg transition-colors shrink-0",
                        subscribedFolder === folder.id
                          ? "text-green-500 bg-green-50"
                          : "text-ink-3 hover:text-blue-500 hover:bg-blue-50"
                      )}
                    >
                      {subscribedFolder === folder.id ? <Check size={14} /> : <Bell size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* 稍后再看视图 */}
        {!selectedFolder && selectedUpperMid === null && tab === "watch_later" && (
          <WatchLaterTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
            onBatchDownload={onBatchDownload}
          />
        )}

        {/* 观看历史视图（cursor 分页） */}
        {!selectedFolder && selectedUpperMid === null && tab === "history" && (
          <WatchHistoryTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
          />
        )}

        {/* 我的关注视图（未选中 UP 主时显示关注列表） */}
        {!selectedFolder &&
          selectedUpperMid === null &&
          tab === "followings" && (
            <FollowingsTab
              onSelectUpper={(mid) => setSelectedUpperMid(mid)}
            />
          )}

        {/* 我的关注 → 选中 UP 主后的主页视图 */}
        {!selectedFolder && selectedUpperMid !== null && (
          <UpperView
            mid={selectedUpperMid}
            scrollRef={scrollRef}
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
            onBatchDownload={onBatchDownload}
          />
        )}

        {/* 我的订阅视图 */}
        {!selectedFolder && selectedUpperMid === null && tab === "subscriptions" && (
          <SubscriptionsTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
            onBatchDownload={onBatchDownload}
          />
        )}

        {/* 追番追剧视图 */}
        {!selectedFolder && selectedUpperMid === null && tab === "bangumi" && (
          <BangumiTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
            onBatchDownloadSeason={onBatchDownloadSeason}
          />
        )}

        {/* 收藏夹视频列表视图 */}
        {selectedFolder && (
          <>
            {onBatchDownload && medias.length > 0 && (
              <BatchBar
                selectMode={favSelectMode}
                onToggleMode={() => setFavSelectMode((v) => !v)}
                selectedCount={favSelected.size}
                totalCount={medias.length}
                onSelectAll={() => setFavSelected(new Set(medias.filter((m) => m.bvid).map((m) => m.bvid)))}
                onClearSelection={() => setFavSelected(new Set())}
                onDownloadSelected={downloadFavSelected}
                busy={favBatchBusy}
              />
            )}
            {medias.length === 0 && !loadingMedias ? (
              <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
                <FolderOpen size={40} strokeWidth={1.5} />
                <p className="text-sm">收藏夹为空</p>
              </div>
            ) : (
              <div className="space-y-2">
                <VirtualList
                  items={medias}
                  scrollRef={scrollRef}
                  estimateSize={96}
                  gap={8}
                  onNearEnd={() => {
                    if (hasMore && !loadingMedias && selectedFolder) {
                      loadMedias(selectedFolder, mediaPage + 1, true);
                    }
                  }}
                  renderItem={(media) => (
                    <div
                      key={media.bvid}
                      onClick={
                        favSelectMode && media.bvid
                          ? () =>
                              setFavSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(media.bvid)) next.delete(media.bvid);
                                else next.add(media.bvid);
                                return next;
                              })
                          : undefined
                      }
                      className={cn(
                        "flex items-start gap-3 w-full px-4 py-3 bg-panel border rounded-lg transition-colors text-left",
                        favSelectMode && "cursor-pointer",
                        favSelectMode && media.bvid && favSelected.has(media.bvid)
                          ? "border-blue-300 bg-blue-50"
                          : "border-line hover:bg-base hover:border-line-2"
                      )}
                    >
                      {/* 封面 */}
                      <div className="relative shrink-0">
                        <img
                          src={media.cover}
                          alt={media.title}
                          className="w-24 h-16 rounded object-cover bg-panel-2"
                        />
                        {favSelectMode && (
                          <span
                            className={cn(
                              "absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full flex items-center justify-center border-2",
                              media.bvid && favSelected.has(media.bvid)
                                ? "bg-blue-500 border-blue-500"
                                : "bg-panel border-line-2"
                            )}
                          >
                            {media.bvid && favSelected.has(media.bvid) && (
                              <Check size={12} className="text-white" />
                            )}
                          </span>
                        )}
                      </div>

                      {/* 信息 */}
                      <button
                        onClick={
                          favSelectMode || parsingBvid === media.bvid
                            ? undefined
                            : () => handleSelectVideo(media)
                        }
                        disabled={!favSelectMode && parsingBvid === media.bvid}
                        className={cn(
                          "flex-1 min-w-0 text-left",
                          !favSelectMode && "cursor-pointer"
                        )}
                      >
                        <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
                          {media.title}
                        </p>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3">
                          <span className="flex items-center gap-0.5">
                            <User size={10} />
                            {media.upper_name}
                          </span>
                          {media.duration != null && media.duration > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Clock size={10} />
                              {formatDuration(media.duration)}
                            </span>
                          )}
                          {media.play > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Eye size={10} />
                              {formatCount(media.play)}
                            </span>
                          )}
                          {media.like > 0 && (
                            <span className="flex items-center gap-0.5">
                              <ThumbsUp size={10} />
                              {formatCount(media.like)}
                            </span>
                          )}
                        </div>
                      </button>

                      {/* 解析中指示器 */}
                      {!favSelectMode && parsingBvid === media.bvid && (
                        <Loader2
                          size={16}
                          className="animate-spin text-blue-500 shrink-0 mt-1"
                        />
                      )}
                    </div>
                  )}
                />

                {/* 加载更多 */}
                {hasMore && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={() =>
                        loadMedias(selectedFolder, mediaPage + 1, true)
                      }
                      disabled={loadingMedias}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-base disabled:opacity-50 transition-colors"
                    >
                      {loadingMedias ? (
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

                {/* 加载指示 */}
                {loadingMedias && medias.length === 0 && (
                  <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
                    <Loader2 size={20} className="animate-spin" />
                    <span className="text-sm">加载中...</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
