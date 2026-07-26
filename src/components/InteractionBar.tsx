import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ThumbsUp,
  Coins,
  Star,
  Loader2,
  ChevronDown,
  Check,
  Zap,
} from "lucide-react";
import type { FavoriteFolder } from "../types";
import { formatCount } from "./VideoCard";
import { useToast } from "./Toast";
import { useLogin } from "../hooks/useLogin";
import { friendlyError } from "../lib/errors";

interface Props {
  bvid: string;
  aid: number;
  /** 视频本身的点赞数（用于显示，互动操作不实时回填此值） */
  likeCount?: number;
}

type ActionKind = "like" | "coin" | "favorite" | "triple";

export function InteractionBar({ bvid, aid, likeCount }: Props) {
  const { userInfo } = useLogin();
  const toast = useToast();
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [liked, setLiked] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  // 本次挂载内用户显式选过的收藏夹：一键三连优先用它，否则回退收藏夹列表第一项（默认收藏夹）
  const [lastFolderId, setLastFolderId] = useState<number | null>(null);

  // 未登录：按钮整体禁用，提示登录
  const loggedIn = !!userInfo;

  const run = async (kind: ActionKind, fn: () => Promise<void>) => {
    if (!loggedIn) {
      toast.error("请先登录后再操作");
      return;
    }
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleLike = () =>
    run("like", async () => {
      const next = liked ? 2 : 1; // 1=点赞 2=取消
      await invoke("like_video", { bvid, like: next });
      setLiked(!liked);
      toast.success(liked ? "已取消点赞" : "点赞成功");
    });

  const handleCoin = () =>
    run("coin", async () => {
      // 投 1 枚，不同时点赞（select_like=0），避免与点赞按钮状态冲突
      await invoke("coin_video", { bvid, multiply: 1, selectLike: 0 });
      toast.success("投币成功");
    });

  const handleOpenFolders = async () => {
    if (!loggedIn) {
      toast.error("请先登录后再操作");
      return;
    }
    if (busy) return;
    setShowFolders((v) => !v);
    // 首次展开时拉取收藏夹列表
    if (folders.length === 0 && !loadingFolders) {
      setLoadingFolders(true);
      try {
        const res = await invoke<FavoriteFolder[]>("get_favorite_folders");
        setFolders(res);
      } catch (e) {
        toast.error(friendlyError(e));
      } finally {
        setLoadingFolders(false);
      }
    }
  };

  const handleFavorite = (folder: FavoriteFolder) =>
    run("favorite", async () => {
      await invoke("favorite_video", { aid, folderId: folder.id });
      setLastFolderId(folder.id);
      setShowFolders(false);
      toast.success(`已收藏到「${folder.title}」`);
    });

  /**
   * 一键三连：点赞 + 投 1 币 + 收藏。三步独立 try/catch——投币失败（如今日已投/币不足）
   * 不阻断收藏，最后汇总 toast。不走 run() 包装器（它首个失败即中断，策略不符）。
   */
  const handleTriple = async () => {
    if (!loggedIn) {
      toast.error("请先登录后再操作");
      return;
    }
    if (busy) return;
    setBusy("triple");
    try {
      const ok: string[] = [];
      const fail: string[] = [];

      // 1) 点赞（幂等：已赞过会在汇总里报失败，不影响后两步）
      try {
        await invoke("like_video", { bvid, like: 1 });
        setLiked(true);
        ok.push("点赞");
      } catch (e) {
        fail.push(`点赞：${friendlyError(e)}`);
      }

      // 2) 投币（1 枚，select_like=0 避免与点赞状态冲突）
      try {
        await invoke("coin_video", { bvid, multiply: 1, selectLike: 0 });
        ok.push("投币");
      } catch (e) {
        fail.push(`投币：${friendlyError(e)}`);
      }

      // 3) 收藏：优先本次显式选过的收藏夹，否则懒加载列表取第一项（B站默认收藏夹排首）
      try {
        let folderId = lastFolderId;
        if (folderId == null) {
          let list = folders;
          if (list.length === 0) {
            list = await invoke<FavoriteFolder[]>("get_favorite_folders");
            setFolders(list);
          }
          folderId = list[0]?.id ?? null;
        }
        if (folderId == null) {
          fail.push("收藏：无可用收藏夹");
        } else {
          await invoke("favorite_video", { aid, folderId });
          ok.push("收藏");
        }
      } catch (e) {
        fail.push(`收藏：${friendlyError(e)}`);
      }

      if (fail.length === 0) {
        toast.success("三连完成");
      } else if (ok.length === 0) {
        toast.error(`三连失败：${fail.join("；")}`);
      } else {
        toast.success(`${ok.join("、")}成功；${fail.join("；")}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2 bg-panel-2 rounded-xl p-2">
      {/* 一键三连（点赞 + 1 币 + 收藏） */}
      <button
        onClick={handleTriple}
        disabled={busy !== null}
        title="点赞 + 投 1 币 + 收藏（收藏夹优先用你这次选过的，否则默认收藏夹）"
        className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border bg-gradient-to-r from-pink-50 to-amber-50 border-pink-200 text-pink-600 hover:from-pink-100 hover:to-amber-100 transition-colors disabled:opacity-50"
      >
        {busy === "triple" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Zap size={13} />
        )}
        三连
      </button>

      {/* 点赞 */}
      <button
        onClick={handleLike}
        disabled={busy !== null}
        className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 ${
          liked
            ? "bg-pink-50 border-pink-300 text-pink-600"
            : "bg-panel border-line text-ink-2 hover:bg-panel-2"
        }`}
      >
        {busy === "like" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <ThumbsUp size={13} fill={liked ? "currentColor" : "none"} />
        )}
        点赞
        {likeCount !== undefined && likeCount > 0 && (
          <span className="text-ink-3">{formatCount(likeCount)}</span>
        )}
      </button>

      {/* 投币 */}
      <button
        onClick={handleCoin}
        disabled={busy !== null}
        className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border bg-panel border-line text-ink-2 hover:bg-panel-2 transition-colors disabled:opacity-50"
      >
        {busy === "coin" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Coins size={13} />
        )}
        投币
      </button>

      {/* 收藏：点击展开收藏夹列表 */}
      <div className="relative">
        <button
          onClick={handleOpenFolders}
          disabled={busy !== null}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border bg-panel border-line text-ink-2 hover:bg-panel-2 transition-colors disabled:opacity-50"
        >
          {busy === "favorite" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Star size={13} />
          )}
          收藏
          <ChevronDown size={11} />
        </button>

        {/* 收藏夹下拉 */}
        {showFolders && (
          <div className="absolute top-full left-0 mt-1 z-20 min-w-[180px] max-h-60 overflow-y-auto bg-panel border border-line rounded-lg shadow-lg py-1">
            {loadingFolders ? (
              <div className="flex items-center justify-center gap-1.5 py-3 text-xs text-ink-3">
                <Loader2 size={12} className="animate-spin" />
                加载中...
              </div>
            ) : folders.length === 0 ? (
              <div className="px-3 py-3 text-xs text-ink-3 text-center">
                暂无收藏夹
              </div>
            ) : (
              folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => handleFavorite(f)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-ink-2 hover:bg-panel-2 transition-colors"
                >
                  <span className="flex-1 truncate">{f.title}</span>
                  <span className="text-ink-3">{f.media_count}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* 已登录标记（视觉提示当前账号可操作） */}
      {loggedIn && (
        <span className="ml-auto flex items-center gap-0.5 text-[10px] text-ink-3">
          <Check size={10} />
          {userInfo!.uname}
        </span>
      )}
    </div>
  );
}
