import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import type { UserInfo } from "../hooks/useLogin";
import { WatchLaterTab } from "./tabs/WatchLaterTab";
import { SubscriptionsTab } from "./tabs/SubscriptionsTab";
import type {
  FavoriteFolder,
  FavoriteMedia,
  FavoriteListResult,
  ParsedVideoInfo,
} from "../types";
import { formatDuration } from "../types";

function formatCount(count: number): string {
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + "万";
  }
  return count.toString();
}

interface UserProfilePageProps {
  userInfo: UserInfo;
  onLogout: () => Promise<void>;
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function UserProfilePage({
  userInfo,
  onLogout,
  onBack,
  onParseVideo,
  onSelectItem,
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

  // 解析状态
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

  const [loggingOut, setLoggingOut] = useState(false);

  // Tab 切换：收藏夹 / 稍后再看 / 我的订阅
  const [tab, setTab] = useState<"favorites" | "watch_later" | "subscriptions">(
    "favorites"
  );

  const handleSetTab = (t: typeof tab) => {
    setTab(t);
    setSelectedFolder(null);
    setMedias([]);
  };

  // 加载收藏夹列表
  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    setFolderError(null);
    try {
      const result = await invoke<FavoriteFolder[]>("get_favorite_folders");
      setFolders(result);
    } catch (e) {
      setFolderError(String(e));
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
        console.error("加载收藏夹视频失败:", e);
      } finally {
        setLoadingMedias(false);
      }
    },
    []
  );

  // 点击收藏夹
  const handleSelectFolder = (folder: FavoriteFolder) => {
    setSelectedFolder(folder);
    setMedias([]);
    setMediaPage(1);
    loadMedias(folder, 1, false);
  };

  // 返回收藏夹列表
  const handleBackToFolders = () => {
    setSelectedFolder(null);
    setMedias([]);
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
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      {/* 顶部标题栏 */}
      <header className="flex items-center gap-3 px-6 py-4 bg-white border-b border-gray-200">
        <button
          onClick={selectedFolder ? handleBackToFolders : onBack}
          className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">
          {selectedFolder ? selectedFolder.title : "个人主页"}
        </h1>
        {selectedFolder && (
          <span className="text-xs text-gray-400">
            {mediaTotal} 个视频
          </span>
        )}
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Tab 切换栏（收藏夹详情视图不显示） */}
        {!selectedFolder && (
          <div className="flex gap-1 mb-4">
            {(
              [
                { key: "favorites", label: "收藏夹", Icon: FolderOpen },
                { key: "watch_later", label: "稍后再看", Icon: Clock },
                { key: "subscriptions", label: "我的订阅", Icon: Bookmark },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => handleSetTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  tab === key
                    ? "bg-blue-50 border-blue-300 text-blue-600"
                    : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
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
            <div className="px-4 py-5 bg-white border border-gray-200 rounded-lg mb-4">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <img
                    src={userInfo.face}
                    alt={userInfo.uname}
                    className="w-16 h-16 rounded-full object-cover border border-gray-200"
                  />
                  {userInfo.vip && (
                    <div className="absolute -bottom-1 -right-1 bg-yellow-400 rounded-full p-0.5">
                      <Crown size={10} className="text-white" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xl font-bold text-gray-800 truncate">
                      {userInfo.uname}
                    </p>
                    <span className="text-xs text-gray-400">
                      {userInfo.sex === "男" ? "♂" : userInfo.sex === "女" ? "♀" : ""}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400 mt-0.5">
                    UID: {userInfo.mid}
                  </p>
                  {userInfo.sign && (
                    <p className="text-xs text-gray-400 mt-1 truncate">
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
              <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-gray-100">
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Star size={12} className="text-yellow-500" />
                    <span className="text-sm font-semibold text-gray-700">Lv.{userInfo.level}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">等级</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Coins size={12} className="text-orange-500" />
                    <span className="text-sm font-semibold text-gray-700">{Math.floor(userInfo.coins)}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">硬币</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Users size={12} className="text-blue-500" />
                    <span className="text-sm font-semibold text-gray-700">{formatCount(userInfo.following)}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">关注</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Users size={12} className="text-pink-500" />
                    <span className="text-sm font-semibold text-gray-700">{formatCount(userInfo.follower)}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">粉丝</p>
                </div>
              </div>
            </div>

            {/* 收藏夹列表 */}
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen size={16} className="text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-700">我的收藏夹</h2>
            </div>

            {loadingFolders ? (
              <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">加载中...</span>
              </div>
            ) : folderError ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
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
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
                <FolderOpen size={40} strokeWidth={1.5} />
                <p className="text-sm">暂无收藏夹</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => handleSelectFolder(folder)}
                    className="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left"
                  >
                    <FolderOpen
                      size={20}
                      className="text-yellow-500 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">
                        {folder.title}
                      </p>
                      <p className="text-xs text-gray-400">
                        {folder.media_count} 个视频
                      </p>
                    </div>
                    <ChevronDown
                      size={14}
                      className="text-gray-300 -rotate-90 shrink-0"
                    />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* 稍后再看视图 */}
        {!selectedFolder && tab === "watch_later" && (
          <WatchLaterTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
          />
        )}

        {/* 我的订阅视图 */}
        {!selectedFolder && tab === "subscriptions" && (
          <SubscriptionsTab
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
          />
        )}

        {/* 收藏夹视频列表视图 */}
        {selectedFolder && (
          <>
            {medias.length === 0 && !loadingMedias ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
                <FolderOpen size={40} strokeWidth={1.5} />
                <p className="text-sm">收藏夹为空</p>
              </div>
            ) : (
              <div className="space-y-2">
                {medias.map((media) => (
                  <button
                    key={media.id}
                    onClick={() => handleSelectVideo(media)}
                    disabled={parsingBvid === media.bvid}
                    className="flex items-start gap-3 w-full px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left disabled:opacity-70"
                  >
                    {/* 封面 */}
                    <img
                      src={media.cover}
                      alt={media.title}
                      className="w-24 h-16 rounded object-cover shrink-0 bg-gray-100"
                    />

                    {/* 信息 */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
                        {media.title}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
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
                    </div>

                    {/* 解析中指示器 */}
                    {parsingBvid === media.bvid && (
                      <Loader2
                        size={16}
                        className="animate-spin text-blue-500 shrink-0 mt-1"
                      />
                    )}
                  </button>
                ))}

                {/* 加载更多 */}
                {hasMore && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={() =>
                        loadMedias(selectedFolder, mediaPage + 1, true)
                      }
                      disabled={loadingMedias}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
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
                  <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
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
