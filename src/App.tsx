import { getVersion } from "@tauri-apps/api/app";
import { lazy, Suspense, useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { DownloadInput } from "./components/DownloadInput";
import { DownloadList } from "./components/DownloadList";
import { ParseList } from "./components/ParseList";
import { VideoDetail } from "./components/VideoDetail";
import { LoginDialog } from "./components/LoginDialog";
import { CaptchaDialog } from "./components/CaptchaDialog";
import { UserProfilePage } from "./components/UserProfilePage";
import { UpperHomePage } from "./components/UpperHomePage";
import { ExplorePage } from "./components/ExplorePage";
import { RankingPage } from "./components/RankingPage";
import { RecommendPage } from "./components/RecommendPage";
import { DynamicPage } from "./components/DynamicPage";
import { RegionPage } from "./components/RegionPage";
import { WeeklyPage } from "./components/WeeklyPage";
import { useToast } from "./components/Toast";
import { useUpdate } from "./contexts/UpdateContext";
import { useSettings } from "./hooks/useSettings";
import { useLogin } from "./hooks/useLogin";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { useUrlIntake } from "./hooks/useUrlIntake";
import { Settings, Download, Search, Trophy, Sparkles, LayoutGrid, Sun, Moon, BarChart3, Rss, CalendarDays } from "lucide-react";
import type { AppSettings } from "./hooks/useSettings";
import { useThemeApplier, type ThemeMode } from "./hooks/useTheme";
import type { ParsedItem, DownloadTask, ParsedVideoInfo, ParseHistoryEntry, DownloadHistoryEntry, VideoMeta, VideoPage, PlayingItem, PlaylistItem, BatchDownloadResult } from "./types";
import { dbToParsedItem, dbToDownloadTask } from "./types";
import { friendlyError } from "./lib/errors";

// 非首屏组件懒加载：设置页/统计页/在线播放器体积较大（播放器含 MSE 逻辑），
// 拆出独立 chunk，首屏 bundle 不再包含它们。三者均为命名导出，需转成 default。
const SettingsPage = lazy(() => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const StatsPanel = lazy(() => import("./components/StatsPanel").then((m) => ({ default: m.StatsPanel })));
const VideoPlayer = lazy(() => import("./components/VideoPlayer").then((m) => ({ default: m.VideoPlayer })));
const ArticleReaderPage = lazy(() => import("./components/ArticleReaderPage").then((m) => ({ default: m.ArticleReaderPage })));

/** 专栏/图文引用：cv 号或 opus id（二选一） */
type ArticleRef = { cvid: number; opusId?: undefined } | { cvid: 0; opusId: string };

/** 从文本提取专栏引用（read/cv 链接、裸 cv 号或 opus 链接），非专栏返回 null。
 *  opus id 保持字符串：19 位数超出 JS 安全整数，Number 会丢精度。 */
function extractArticleRef(text: string): ArticleRef | null {
  const opus = /bilibili\.com\/opus\/(\d+)/i.exec(text);
  if (opus) return { cvid: 0, opusId: opus[1] };
  const cv = /\bcv(\d{4,})\b/i.exec(text);
  if (cv) return { cvid: Number(cv[1]) };
  return null;
}

type View = "main" | "settings" | "detail" | "downloads" | "stats" | "profile" | "explore" | "ranking" | "recommend" | "region" | "dynamic" | "weekly";

/** 视图枚举 → 面包屑来源中文名（详情页/UP 主主页头部用，back 回到该来源） */
function viewLabel(view: View): string {
  switch (view) {
    case "main": return "主页";
    case "explore": return "发现";
    case "ranking": return "排行榜";
    case "recommend": return "推荐";
    case "region": return "分区";
    case "dynamic": return "动态";
    case "weekly": return "每周必看";
    case "profile": return "我的";
    case "downloads": return "下载";
    case "stats": return "统计";
    case "settings": return "设置";
    case "detail": return "视频详情";
  }
}

export default function App() {
  const [currentView, setCurrentView] = useState<View>("main");
  const [previousView, setPreviousView] = useState<View>("main");
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const [captchaVoucher, setCaptchaVoucher] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ParsedItem | null>(null);
  // UP 主主页覆盖层：从详情页点头像进入，叠加在详情之上。null=未打开。
  const [upperViewMid, setUpperViewMid] = useState<number | null>(null);
  // 在线播放覆盖层：从详情页「在线播放」进入，最上层。null=未打开。
  const [playingItem, setPlayingItem] = useState<PlayingItem | null>(null);
  // 专栏阅读覆盖层：解析输入 cv/opus 链接时打开。null=未打开。
  const [articleRef, setArticleRef] = useState<ArticleRef | null>(null);
  // 分页 state
  const [parsePage, setParsePage] = useState(1);
  const [parseTotal, setParseTotal] = useState(0);
  const [downloadPage, setDownloadPage] = useState(1);
  const [downloadTotal, setDownloadTotal] = useState(0);

  const { phase, updateInfo } = useUpdate();
  const { settings, save, patch } = useSettings();
  // 主题切换走 patch_settings 局部保存：拿陈旧 settings 快照整份覆盖会把
  // 设置页里未保存的修改静默回滚。
  const { resolved: resolvedTheme, toggle: toggleTheme } = useThemeApplier(
    settings.theme,
    useCallback((t: ThemeMode) => patch({ theme: t }), [patch])
  );
  const { userInfo, logout, generateQrcode, pollQrcode } = useLogin();
  const toast = useToast();
  const [version, setVersion] = useState("");
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  // 分页加载函数
  const loadParsePage = useCallback(async (page: number) => {
    try {
      const [parses, total] = await Promise.all([
        invoke<ParseHistoryEntry[]>("get_parse_history", { page }),
        invoke<number>("get_parse_count"),
      ]);
      setParsedItems(parses.map(dbToParsedItem));
      setParseTotal(total);
      setParsePage(page);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  }, [toast]);

  const loadDownloadPage = useCallback(async (page: number) => {
    try {
      const [history, total] = await Promise.all([
        invoke<DownloadHistoryEntry[]>("get_download_history", { page }),
        invoke<number>("get_download_count"),
      ]);
      setDownloads(history.map(dbToDownloadTask));
      setDownloadTotal(total);
      setDownloadPage(page);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  }, [toast]);

  // 启动时从 DB 加载第一页
  useEffect(() => {
    loadParsePage(1);
    loadDownloadPage(1);
  }, []);

  // 下载事件监听（订阅 + 双层节流 + 落库逻辑已抽到 hook）
  const { downloadingIds } = useDownloadEvents({
    setDownloads,
    onRiskControl: (vVoucher) => {
      setCaptchaVoucher(vVoucher);
      toast.error("触发风控验证，请完成验证后重试");
    },
    onDownloadError: (error) => {
      // 风控错误已有专门的 risk_control 事件弹窗（onRiskControl），这里不再重复 toast
      if (!error.startsWith("RISK_CONTROL:")) {
        toast.error(`下载失败：${error}`);
      }
    },
  });

  // 解析输入框（受控：剪贴板/拖放识别到的链接从这里填入）
  const [inputUrl, setInputUrl] = useState("");
  // currentView 镜像进 ref：useUrlIntake 监听器只注册一次，经 ref 读最新视图
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;

  // 剪贴板/拖放链接感知：识别到新链接自动填入解析输入框；专栏链接直接打开阅读页。
  // 拖放从任意视图生效（跳回主页）；剪贴板探测仅主页生效（避免其他视图被打断）。
  const handleUrlIntake = useCallback((url: string) => {
    const ref = extractArticleRef(url);
    if (ref != null) {
      setCurrentView((v) => (v === "main" ? v : "main"));
      setArticleRef(ref);
      return;
    }
    setCurrentView((v) => (v === "main" ? v : "main"));
    setInputUrl(url);
  }, []);
  useUrlIntake({
    onUrl: handleUrlIntake,
    clipboardEnabled: () => currentViewRef.current === "main",
  });

  const hasUpdate = phase === "available" && updateInfo;
  const activeDownloads = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;

  const handleSaveSettings = async (s: AppSettings) => {
    await save(s);
  };

  const handleParse = async (url: string) => {
    // 同毫秒内并发解析（多入口）会撞 id：加随机后缀
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: ParsedItem = {
      id,
      url,
      title: url,
      status: "parsing",
    };
    setParsedItems((prev) => [item, ...prev]);
    setIsParsing(true);

    try {
      const videoInfo = await invoke<ParsedVideoInfo>("parse_video", { urlStr: url });
      setParsedItems((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, title: videoInfo.title, status: "pending" as const, videoInfo }
            : p
        )
      );
      // 持久化解析成功的记录：仅当用户停留在第 1 页时刷新列表（乐观更新已在上面完成），
      // 否则不打断用户对其他页的浏览，仅 toast 提示已记录。
      invoke("save_parse_history", {
        entry: { id, url, bvid: videoInfo.bvid, title: videoInfo.title, video_info: videoInfo, parsed_at: new Date().toISOString() }
      })
        .then(() => {
          if (parsePage === 1) {
            loadParsePage(1);
          }
        })
        .catch(() => {});
      setInputUrl(""); // 解析成功清空输入框（失败分支保留文本供用户编辑）
      return videoInfo;
    } catch (err) {
      setParsedItems((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, status: "error" as const, errorMsg: friendlyError(err) }
            : p
        )
      );
      toast.error(`解析失败：${friendlyError(err)}`);
      throw err;
    } finally {
      setIsParsing(false);
    }
  };

  // 并发控制已移到 Rust 后端（Semaphore），前端直接 invoke 即可
  const handleDownload = async (
    id: string,
    bvid: string,
    cid: number,
    title: string,
    videoTitle: string,
    epId?: number,
    duration?: number,
    pic?: string,
    subtitleOnly?: boolean,
    audioOnly?: boolean,
    videoMeta?: VideoMeta,
    ownerName?: string,
    qn?: number | null
  ): Promise<boolean> => {
    // 用 ref 防止重复提交（queued/downloading 都算活跃，禁止重复）
    if (downloadingIds.current.has(id)) return true;
    downloadingIds.current.add(id);

    // UP 主名：显式参数优先（恢复/重试从 DB 回传），其次取 videoMeta 透传（新提交）
    const owner = ownerName ?? videoMeta?.owner_name;

    // 先加入 UI 列表（显示为 queued，dispatcher 拿到 permit 后会 emit downloading）。
    // 同时填充恢复/重试所需的原始参数。
    setDownloads((prev) => {
      const filtered = prev.filter((d) => d.id !== id);
      return [{
        id, title, status: "queued" as const, progress: 0, pic,
        bvid, cid, epId: epId ?? null, videoTitle, duration, ownerName: owner,
      }, ...filtered];
    });

    // 持久化下载记录（含封面 + 恢复参数）。
    // quality 此处未知（需 playurl 后才确定），暂存 null；跨会话续传由流指纹保护。
    invoke("save_download_entry", {
      entry: {
        id, title, bvid, cid, ep_id: epId ?? null,
        status: "queued", progress: 0, phase: null,
        error_msg: null, output_path: null,
        pic: pic ?? null, created_at: new Date().toISOString(),
        // qn 落库：恢复/重试时作为 qn 重新提交，保证跨会话续传的流指纹匹配
        quality: qn ?? null, video_title: videoTitle || null,
        duration: duration ?? null,
        owner_name: owner ?? null,
        // 模式落库（101 schema 新列）：恢复/重试时按同模式提交，
        // 否则仅字幕/仅音频任务重试后会变成下载完整视频
        subtitle_only: subtitleOnly ?? false,
        audio_only: audioOnly ?? false,
      }
    }).catch(() => {});

    // 提交到调度器（立即返回；下载中途状态/进度/完成/失败全走事件）。
    // 命令返回的 Err 仅代表提交阶段失败（如未登录）。
    try {
      await invoke("download_video", { id, bvid, cid, title, videoTitle, epId, duration, subtitleOnly, audioOnly, videoMeta, ownerName: owner ?? null, qn: qn ?? null });
      // downloadingIds 在 download://complete/error/state(cancelled) 中清理
      return true;
    } catch (err) {
      downloadingIds.current.delete(id);
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, status: "error" as const, errorMsg: friendlyError(err) } : d
        )
      );
      toast.error(`下载失败：${friendlyError(err)}`);
      return false;
    }
  };

  // 解析输入框入口：专栏/图文链接（cv 号或 opus）直接打开阅读页，其余走视频解析。
  // 其他页面的 onParseVideo 不经过此入口（它们只传视频/番剧链接）。
  const handleParseFromInput = (url: string) => {
    const ref = extractArticleRef(url);
    if (ref != null) {
      setArticleRef(ref);
      setInputUrl("");
      return;
    }
    void handleParse(url).catch(() => { /* 错误已在 handleParse 内 toast */ });
  };

  const handleSelectItem = (item: ParsedItem) => {
    if (!item.videoInfo) return;
    // 更新时间戳，使其置顶
    if (item.videoInfo.bvid) {
      invoke("touch_parse_history", { bvid: item.videoInfo.bvid }).catch(() => {});
    }
    setSelectedItem(item);
    setPreviousView("main");
    setCurrentView("detail");
  };

  const handleRemoveParsed = (id: string) => {
    // 先判断删除后当前页是否变空（仅剩这一条且非首页）→ 回退到上一页
    const willBeEmpty = parsedItems.length === 1 && parsePage > 1;
    setParsedItems((prev) => prev.filter((p) => p.id !== id));
    invoke("delete_parse_history", { id })
      .then(() => loadParsePage(willBeEmpty ? parsePage - 1 : parsePage))
      .catch(() => {});
  };

  const handleRemoveDownload = (id: string) => {
    const willBeEmpty = downloads.length === 1 && downloadPage > 1;
    setDownloads((prev) => prev.filter((d) => d.id !== id));
    invoke("delete_download_history", { id })
      .then(() => loadDownloadPage(willBeEmpty ? downloadPage - 1 : downloadPage))
      .catch(() => {});
  };

  // 暂停运行中任务（保留 .tmp 供恢复续传），或移除排队中任务
  const handlePause = (id: string) => {
    invoke<boolean>("pause_download", { id })
      .then((ok) => {
        if (!ok) toast.error("暂停失败：任务可能已完成或不存在");
      })
      .catch((e) => toast.error(`暂停失败：${friendlyError(e)}`));
  };

  // 取消任务（中断运行并清理 .tmp，或移除排队任务）。后端 emit state(cancelled) 后会从列表移除
  const handleCancel = (id: string) => {
    invoke<boolean>("cancel_download", { id })
      .then((ok) => {
        if (!ok) {
          // 后端没有该任务（可能已完成），直接前端移除
          handleRemoveDownload(id);
        }
      })
      .catch((e) => toast.error(`取消失败：${friendlyError(e)}`));
  };

  // 恢复已暂停的任务：用原 id + 原参数重新提交（后端检测 .tmp 存在且指纹匹配则续传）。
  // 复用 handleDownload 的全套逻辑（去重、UI 插入、落库、提交）。
  const handleResume = (item: DownloadTask) => {
    if (!item.bvid || item.cid === undefined) {
      toast.error("恢复失败：缺少下载参数");
      return;
    }
    // 透传原始模式（仅字幕/仅音频）与画质（qn）：画质一致才能命中续传指纹，
    // 模式一致才不会把字幕库任务变成下整视频
    void handleDownload(
      item.id, item.bvid, item.cid, item.title, item.videoTitle || item.title,
      item.epId ?? undefined, item.duration, item.pic,
      item.subtitleOnly ?? undefined, item.audioOnly ?? undefined, undefined, item.ownerName,
      item.quality ?? null
    );
  };

  // 重试失败的任务（与恢复同：用原参数重新提交）
  const handleRetry = (item: DownloadTask) => {
    if (!item.bvid || item.cid === undefined) {
      toast.error("重试失败：缺少下载参数");
      return;
    }
    void handleDownload(
      item.id, item.bvid, item.cid, item.title, item.videoTitle || item.title,
      item.epId ?? undefined, item.duration, item.pic,
      item.subtitleOnly ?? undefined, item.audioOnly ?? undefined, undefined, item.ownerName,
      item.quality ?? null
    );
  };

  // 调整排队中任务的优先级（置顶：用一个比当前最高优先级更大的值）
  const handleSetPriority = (id: string, priority: number) => {
    invoke<boolean>("set_download_priority", { id, priority })
      .then((ok) => {
        if (!ok) toast.error("调整失败：任务已开始下载或不存在");
      })
      .catch((e) => toast.error(`调整失败：${friendlyError(e)}`));
  };

  // 批量下载一组 BV 号（列表页多选场景）。后端逐个解析 cid 并入队，
  // 已在下载历史的自动跳过；完成后刷新下载列表第一页让新任务立即可见。
  const handleBatchDownload = async (bvids: string[], folder?: string) => {
    if (bvids.length === 0) return;
    try {
      const res = await invoke<BatchDownloadResult>("batch_download_bvids", {
        bvids,
        folder: folder ?? null,
      });
      if (res.queued > 0) {
        toast.success(`批量下载：${res.queued} 个已加入队列${res.skipped > 0 ? `，${res.skipped} 个已存在/失败跳过` : ""}`);
      } else {
        toast.error(`没有新任务：${res.skipped} 个视频均已下载或正在队列中`);
      }
      loadDownloadPage(1);
    } catch (e) {
      toast.error(`批量下载失败：${friendlyError(e)}`);
    }
  };

  // 批量下载整部番剧（按 season_id，后端解析全部正片入队）
  const handleBatchDownloadSeason = async (seasonId: number, _title: string) => {
    try {
      const res = await invoke<BatchDownloadResult>("batch_download_season", { seasonId });
      if (res.queued > 0) {
        toast.success(`整季下载：${res.queued} 集已加入队列${res.skipped > 0 ? `，${res.skipped} 集已存在跳过` : ""}`);
      } else {
        toast.error(`没有新任务：${res.skipped} 集均已下载或正在队列中`);
      }
      loadDownloadPage(1);
    } catch (e) {
      toast.error(`整季下载失败：${friendlyError(e)}`);
    }
  };

  // 全部暂停：排队移除 + 运行中断（保留 .tmp 续传）
  const handlePauseAll = () => {
    invoke<number>("pause_all_downloads")
      .catch((e) => toast.error(`全部暂停失败：${friendlyError(e)}`));
  };

  // 重试当前页全部失败任务
  const handleRetryAllFailed = () => {
    const failed = downloads.filter((d) => d.status === "error");
    if (failed.length === 0) return;
    failed.forEach((item) => handleRetry(item));
    toast.success(`已重新提交 ${failed.length} 个失败任务`);
  };

  // 打开下载文件所在目录：
  // 1) 若有 output_path 且文件存在 → revealItemInDir 选中该文件
  // 2) 文件不存在（用户已删除）或无 output_path → 回退打开设置里的下载目录 default_download_dir
  // 3) 仍失败 → toast 提示
  const handleOpenFolder = async (item: DownloadTask) => {
    // 先尝试在资源管理器中选中下载好的文件
    if (item.outputPath) {
      try {
        await revealItemInDir(item.outputPath);
        return;
      } catch {
        // 文件可能已被用户删除，静默回退到下载目录
      }
    }
    // 回退：打开设置中的下载目录
    const dir = settings.default_download_dir;
    if (!dir) {
      toast.error("无法获取下载目录，请在设置中配置下载路径");
      return;
    }
    try {
      await openPath(dir);
    } catch (e) {
      toast.error(`打开目录失败：${friendlyError(e)}`);
    }
  };

  // 点击封面进入视频详情页：用 bvid/epId 重建 URL → 调 parse_video 拿完整 videoInfo → 跳转
  const handleOpenDetail = async (item: DownloadTask) => {
    const url = item.epId
      ? `https://www.bilibili.com/bangumi/play/ep${item.epId}`
      : item.bvid
      ? `https://www.bilibili.com/video/${item.bvid}`
      : null;
    if (!url) {
      toast.error("无法获取视频信息");
      return;
    }
    setIsParsing(true);
    try {
      const videoInfo = await invoke<ParsedVideoInfo>("parse_video", { urlStr: url });
      setSelectedItem({
        id: `dl-${item.id}`,
        url,
        title: videoInfo.title,
        status: "pending",
        videoInfo,
      });
      setPreviousView("downloads");
      setCurrentView("detail");
    } catch (e) {
      toast.error(`打开详情失败：${friendlyError(e)}`);
    } finally {
      setIsParsing(false);
    }
  };

  // 详情页返回逻辑：回到来源页，保留其 state（来源页组件未被卸载）
  // 返回时保持当前页码（修复：原先强制回到第 1 页，丢失用户的分页位置）
  const handleDetailBack = () => {
    const prev = previousView;
    setCurrentView(prev);
    setSelectedItem(null);
    if (prev === "main") loadParsePage(parsePage);
  };

  // 从详情页点击 UP 主头像 → 打开该 UP 主主页覆盖层（叠加在详情之上）
  const handleOpenUpper = (mid: number) => {
    setUpperViewMid(mid);
  };

  // 从详情页点击「在线播放」→ 打开 MSE 播放器覆盖层（最上层 z-[70]）
  const handlePlay = (p: PlayingItem) => {
    setPlayingItem(p);
  };

  // 播放列表模式：从每周必看/收藏夹等场景传入跨稿件列表，打开播放器连续播放。
  // 起始项作为初始 playingItem 载荷，playlist 随会话穿线给 VideoPlayer。
  const handlePlayPlaylist = (items: PlaylistItem[], startIndex: number) => {
    if (items.length === 0) return;
    const start = items[Math.min(startIndex, items.length - 1)];
    setPlayingItem({
      bvid: start.bvid,
      aid: start.aid,
      cid: start.cid,
      epId: start.epId,
      duration: start.duration,
      title: start.title,
      playlist: items,
      playlistIndex: Math.min(startIndex, items.length - 1),
    });
  };

  // 在 UP 主主页覆盖层中点开某个视频：替换当前详情页内容并关闭 UP 主页覆盖层。
  // previousView 保持不变，从新详情返回时仍回到原来源页（main/explore/...）。
  const handleSelectFromUpper = (videoInfo: ParsedVideoInfo) => {
    const item: ParsedItem = {
      id: `upper-${videoInfo.bvid}`,
      url: videoInfo.bvid ? `https://www.bilibili.com/video/${videoInfo.bvid}` : "",
      title: videoInfo.title,
      status: "pending",
      videoInfo,
    };
    if (videoInfo.bvid) {
      invoke("touch_parse_history", { bvid: videoInfo.bvid }).catch(() => {});
    }
    setSelectedItem(item);
    setUpperViewMid(null);
  };

  // 各来源页（我的/发现/排行榜/推荐/分区）点开视频卡片 → 详情覆盖层的公共跳转逻辑。
  // idPrefix 区分来源避免 item id 碰撞；source 记录来源视图，返回时回到该页。
  const openDetail = (videoInfo: ParsedVideoInfo, source: View, idPrefix: string) => {
    const item: ParsedItem = {
      id: `${idPrefix}-${videoInfo.bvid}`,
      url: videoInfo.bvid ? `https://www.bilibili.com/video/${videoInfo.bvid}` : "",
      title: videoInfo.title,
      status: "pending",
      videoInfo,
    };
    if (videoInfo.bvid) {
      invoke("touch_parse_history", { bvid: videoInfo.bvid }).catch(() => {});
    }
    setSelectedItem(item);
    setPreviousView(source);
    setCurrentView("detail");
  };

  // 视频详情覆盖层：无论当前在哪个视图都叠在最上层。
  // 关键：来源页组件保持挂载不被卸载，返回时其 state（搜索结果、UP 主投稿列表、
  // 收藏夹视频等）完整保留，避免返回后回到空白初始页。
  //
  // 结构拆为两部分：
  // 1) 详情容器（VideoDetail + UP 主页）——仅 currentView==="detail" 时渲染；
  // 2) 在线播放器（VideoPlayer）——只要 playingItem 非空就渲染，与当前视图无关。
  //    这样从「每周必看」等非详情视图点「连续播放」也能正常弹出播放器。
  //    VideoPlayer 自身是 fixed inset-0 z-[70]，作为兄弟节点仍铺满视口且置于最上层。
  const detailOverlay = (
    <>
      {currentView === "detail" && selectedItem && (
        <div className="fixed inset-0 z-50 bg-base">
          <VideoDetail
            entry={selectedItem}
            sourceLabel={viewLabel(previousView)}
            onBack={handleDetailBack}
            onOpenUpper={handleOpenUpper}
            onPlay={handlePlay}
            onDownload={handleDownload}
            onOpenRelated={async (bvid: string) => {
              // 相关推荐跳转：解析后替换当前详情内容（来源页保持不变）
              const url = `https://www.bilibili.com/video/${bvid}`;
              setIsParsing(true);
              try {
                const videoInfo = await handleParse(url);
                if (videoInfo) {
                  setSelectedItem({
                    id: `rel-${videoInfo.bvid}`,
                    url,
                    title: videoInfo.title,
                    status: "pending",
                    videoInfo,
                  });
                }
              } catch {
                /* 错误已在 handleParse 内 toast */
              } finally {
                setIsParsing(false);
              }
            }}
          />
          {/* UP 主主页覆盖层：从详情页点头像进入，叠加在详情之上（更高 z-index）。
              外层 fixed 无 transform，内层 fixed 仍相对视口铺满；z-[60] > z-50，
              故本层绘制在 VideoDetail 之上。返回关闭本层 → 回到详情；
              点开某视频 → handleSelectFromUpper 替换详情内容并关闭本层。 */}
          {upperViewMid !== null && (
            <div className="fixed inset-0 z-[60] bg-base">
              <UpperHomePage
                mid={upperViewMid}
                sourceLabel="视频详情"
                onBack={() => setUpperViewMid(null)}
                onParseVideo={handleParse}
                onSelectItem={handleSelectFromUpper}
                onBatchDownload={handleBatchDownload}
              />
            </div>
          )}
        </div>
      )}
      {/* 在线播放覆盖层：MSE 播放器，最上层 z-[70]（懒加载，chunk 加载期间不渲染）。
          独立于详情视图：从任意视图（详情/每周必看等）触发播放都能弹出。 */}
      {playingItem && (
        <Suspense fallback={null}>
          <VideoPlayer
            bvid={playingItem.bvid}
            aid={playingItem.aid}
            cid={playingItem.cid}
            epId={playingItem.epId}
            duration={playingItem.duration}
            title={playingItem.title}
            pages={playingItem.pages}
            playlist={playingItem.playlist}
            playlistIndex={playingItem.playlistIndex}
            danmakuStyle={{
              fontSize: settings.danmaku_font_size,
              scrollDuration: settings.danmaku_scroll_duration,
              opacity: Math.min(Math.max(settings.danmaku_opacity, 0.05), 1),
              blockTop: settings.danmaku_block_top,
              blockBottom: settings.danmaku_block_bottom,
            }}
            onBack={() => setPlayingItem(null)}
          />
        </Suspense>
      )}
    </>
  );

  // Settings view
  if (currentView === "settings") {
    return (
      <>
        <div className="flex flex-col h-screen bg-base text-ink">
          <Suspense fallback={null}>
            <SettingsPage
              settings={settings}
              onSave={handleSaveSettings}
              onPatch={patch}
              onBack={() => setCurrentView("main")}
              onClearParse={() => loadParsePage(1)}
              onClearDownload={() => loadDownloadPage(1)}
            />
          </Suspense>
        </div>
        {detailOverlay}
      </>
    );
  }

  // Downloads view
  // detail 状态下若来源是 downloads，仍渲染下载列表页（被详情覆盖层遮挡），
  // 返回时分页与列表 state 不丢失。
  if (currentView === "downloads" || (currentView === "detail" && previousView === "downloads")) {
    return (
      <>
        <div className="flex flex-col h-screen bg-base text-ink">
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-line bg-panel">
            <button
              onClick={() => setCurrentView("main")}
              className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
            >
              <Download size={16} className="rotate-180" />
            </button>
            <h1 className="text-lg font-semibold text-ink">下载列表</h1>
            {activeDownloads > 0 && (
              <span className="text-xs text-blue-500 font-medium">
                {activeDownloads} 个任务进行中
              </span>
            )}
            {/* 批量操作：全部暂停（保留续传）/ 重试当前页全部失败 */}
            <div className="ml-auto flex items-center gap-2">
              {activeDownloads > 0 && (
                <button
                  onClick={handlePauseAll}
                  className="px-3 py-1.5 text-xs text-amber-600 border border-amber-200 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  全部暂停
                </button>
              )}
              {downloads.some((d) => d.status === "error") && (
                <button
                  onClick={handleRetryAllFailed}
                  className="px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  重试全部失败
                </button>
              )}
            </div>
          </div>

          {/* Download list */}
          <div className="flex-1 overflow-auto px-6 py-4">
            <DownloadList
              downloads={downloads}
              onRemove={handleRemoveDownload}
              onPause={handlePause}
              onCancel={handleCancel}
              onResume={handleResume}
              onRetry={handleRetry}
              onSetPriority={handleSetPriority}
              onOpenFolder={handleOpenFolder}
              onOpenDetail={handleOpenDetail}
              currentPage={downloadPage}
              totalCount={downloadTotal}
              onPageChange={loadDownloadPage}
            />
          </div>
        </div>
        {detailOverlay}
      </>
    );
  }

  // Stats view
  // detail 状态下若来源是 stats，仍渲染统计页（被详情覆盖层遮挡），返回时 state 不丢失。
  if (currentView === "stats" || (currentView === "detail" && previousView === "stats")) {
    return (
      <>
        <Suspense fallback={null}>
          <StatsPanel onBack={() => setCurrentView("main")} />
        </Suspense>
        {detailOverlay}
      </>
    );
  }
  // 注意：detail 视图不再独占渲染，而是作为覆盖层叠加在来源页之上，
  // 这样来源页（main/explore/profile）组件不会被卸载，返回时其 state（搜索结果、
  // UP 主投稿列表、收藏夹视频等）得以保留。详情覆盖层在最末尾渲染。
  // Profile view
  // detail 状态下若来源是 profile，仍渲染 UserProfilePage（被覆盖层遮挡），
  // 返回时收藏夹视频列表等 state 不丢失。
  if (
    (currentView === "profile" || (currentView === "detail" && previousView === "profile")) &&
    userInfo
  ) {
    return (
      <>
        <UserProfilePage
          userInfo={userInfo}
          onLogout={logout}
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "profile", "fav")}
          onBatchDownload={handleBatchDownload}
          onBatchDownloadSeason={handleBatchDownloadSeason}
        />
        {detailOverlay}
      </>
    );
  }

  // Explore view
  // detail 状态下若来源是 explore，仍渲染 ExplorePage（被详情覆盖层遮挡），
  // 保证返回时 ExplorePage 的 state（搜索结果、UP 主投稿列表）不丢失。
  if (currentView === "explore" || (currentView === "detail" && previousView === "explore")) {
    return (
      <>
        <ExplorePage
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "explore", "explore")}
          onBatchDownload={handleBatchDownload}
        />
        {detailOverlay}
      </>
    );
  }

  // Ranking view
  // detail 状态下若来源是 ranking，仍渲染 RankingPage（被详情覆盖层遮挡），
  // 保证返回时 RankingPage 的 state（筛选器与排行列表）不丢失。
  if (currentView === "ranking" || (currentView === "detail" && previousView === "ranking")) {
    return (
      <>
        <RankingPage
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "ranking", "ranking")}
        />
        {detailOverlay}
      </>
    );
  }

  // Recommend view
  // detail 状态下若来源是 recommend，仍渲染 RecommendPage（被详情覆盖层遮挡），
  // 保证返回时 RecommendPage 的 state（推荐列表与 fresh_idx）不丢失。
  if (currentView === "recommend" || (currentView === "detail" && previousView === "recommend")) {
    return (
      <>
        <RecommendPage
          userInfo={userInfo}
          onLogin={() => setLoginDialogOpen(true)}
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "recommend", "recommend")}
        />
        {detailOverlay}
      </>
    );
  }

  // Region view
  // detail 状态下若来源是 region，仍渲染 RegionPage（被详情覆盖层遮挡），
  // 保证返回时 RegionPage 的 state（分区筛选与列表）不丢失。
  if (currentView === "region" || (currentView === "detail" && previousView === "region")) {
    return (
      <>
        <RegionPage
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "region", "region")}
        />
        {detailOverlay}
      </>
    );
  }

  // Dynamic view
  // detail 状态下若来源是 dynamic，仍渲染 DynamicPage（被详情覆盖层遮挡），
  // 保证返回时 DynamicPage 的 state（动态列表与游标）不丢失。
  if (currentView === "dynamic" || (currentView === "detail" && previousView === "dynamic")) {
    return (
      <>
        <DynamicPage
          userInfo={userInfo}
          onLogin={() => setLoginDialogOpen(true)}
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "dynamic", "dynamic")}
        />
        {detailOverlay}
      </>
    );
  }

  // Weekly view（每周必看）
  // detail 状态下若来源是 weekly，仍渲染 WeeklyPage（被详情覆盖层遮挡），
  // 保证返回时 WeeklyPage 的 state（期数选择与视频列表）不丢失。
  if (currentView === "weekly" || (currentView === "detail" && previousView === "weekly")) {
    return (
      <>
        <WeeklyPage
          onBack={() => setCurrentView("main")}
          onParseVideo={handleParse}
          onSelectItem={(videoInfo: ParsedVideoInfo) => openDetail(videoInfo, "weekly", "weekly")}
          onPlayPlaylist={handlePlayPlaylist}
          onBatchDownload={handleBatchDownload}
        />
        {detailOverlay}
      </>
    );
  }

  // Main view
  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between px-6 py-4 bg-panel border-b border-line">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-ink">BilbliCopy</h1>
          <span className="text-xs text-ink-3">v{version}</span>
          {/* 设置按钮（紧跟版本号） */}
          <div className="relative">
            <button
              onClick={() => setCurrentView("settings")}
              title="设置"
              className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
            >
              <Settings size={16} />
            </button>
            {/* 更新红点提示 */}
            {hasUpdate && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500" />
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 主题切换：浅色显月亮（点击转深色），深色显太阳（点击转浅色） */}
          <button
            onClick={toggleTheme}
            title={resolvedTheme === "dark" ? "切换到浅色" : "切换到深色"}
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            {resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          {/* 发现入口 */}
          <button
            onClick={() => setCurrentView("explore")}
            title="发现"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <Search size={16} />
          </button>

          {/* 排行榜入口 */}
          <button
            onClick={() => setCurrentView("ranking")}
            title="热门排行榜"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <Trophy size={16} />
          </button>

          {/* 推荐视频入口 */}
          <button
            onClick={() => setCurrentView("recommend")}
            title="推荐视频"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <Sparkles size={16} />
          </button>

          {/* 关注动态入口 */}
          <button
            onClick={() => setCurrentView("dynamic")}
            title="关注动态"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <Rss size={16} />
          </button>

          {/* 分区浏览入口 */}
          <button
            onClick={() => setCurrentView("region")}
            title="分区浏览"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <LayoutGrid size={16} />
          </button>

          {/* 每周必看入口 */}
          <button
            onClick={() => setCurrentView("weekly")}
            title="每周必看"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <CalendarDays size={16} />
          </button>

          {/* 下载列表入口 */}
          <div className="relative">
            <button
              onClick={() => setCurrentView("downloads")}
              title="下载列表"
              className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
            >
              <Download size={16} />
            </button>
            {activeDownloads > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-blue-500 text-white text-[10px] font-medium px-1">
                {activeDownloads}
              </span>
            )}
          </div>

          {/* 统计入口 */}
          <button
            onClick={() => setCurrentView("stats")}
            title="下载统计"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <BarChart3 size={16} />
          </button>

          {/* 登录按钮 / 头像（最右边） */}
          {userInfo ? (
            <button
              onClick={() => setCurrentView("profile")}
              className="p-0.5 rounded-full hover:ring-2 hover:ring-blue-300 transition-all"
            >
              <img
                src={userInfo.face}
                alt={userInfo.uname}
                className="w-7 h-7 rounded-full object-cover"
              />
            </button>
          ) : (
            <button
              onClick={() => setLoginDialogOpen(true)}
              className="px-3 py-1 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors"
            >
              登录
            </button>
          )}
        </div>
      </header>

      {/* URL 输入区 */}
      <div className="px-6 py-3 bg-panel border-b border-line">
        <DownloadInput value={inputUrl} onChange={setInputUrl} onParse={handleParseFromInput} isParsing={isParsing} />
      </div>

      {/* 解析列表 */}
      <div className="flex-1 overflow-auto px-6 py-2">
        <ParseList
          items={parsedItems}
          onRemove={handleRemoveParsed}
          onSelect={handleSelectItem}
          currentPage={parsePage}
          totalCount={parseTotal}
          onPageChange={loadParsePage}
        />
      </div>

      {/* 登录弹窗 */}
      <LoginDialog
        open={loginDialogOpen}
        onClose={() => setLoginDialogOpen(false)}
        onSuccess={() => setLoginDialogOpen(false)}
        generateQrcode={generateQrcode}
        pollQrcode={pollQrcode}
      />

      {/* 风控验证码弹窗 */}
      <CaptchaDialog
        vVoucher={captchaVoucher}
        onSuccess={() => setCaptchaVoucher(null)}
        onCancel={() => setCaptchaVoucher(null)}
      />

      {/* 专栏/图文阅读覆盖层（最上层 z-[80]，懒加载） */}
      {articleRef != null && (
        <Suspense fallback={null}>
          <ArticleReaderPage cvid={articleRef.cvid} opusId={articleRef.opusId} onBack={() => setArticleRef(null)} />
        </Suspense>
      )}

      {detailOverlay}
    </div>
  );
}
