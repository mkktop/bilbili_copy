import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DownloadInput } from "./components/DownloadInput";
import { DownloadList } from "./components/DownloadList";
import { ParseList } from "./components/ParseList";
import { VideoDetail } from "./components/VideoDetail";
import { SettingsPage } from "./components/SettingsPage";
import { LoginDialog } from "./components/LoginDialog";
import { CaptchaDialog } from "./components/CaptchaDialog";
import { UserProfilePage } from "./components/UserProfilePage";
import { ExplorePage } from "./components/ExplorePage";
import { useToast } from "./components/Toast";
import { useUpdate } from "./contexts/UpdateContext";
import { useSettings } from "./hooks/useSettings";
import { useLogin } from "./hooks/useLogin";
import { Settings, Download, Search } from "lucide-react";
import type { AppSettings } from "./hooks/useSettings";
import type { ParsedItem, DownloadTask, ParsedVideoInfo, ParseHistoryEntry, DownloadHistoryEntry, VideoMeta } from "./types";
import { dbToParsedItem, dbToDownloadTask } from "./types";
import { friendlyError } from "./lib/errors";
import { DOWNLOAD_PROGRESS_THROTTLE_MS } from "./lib/constants";

type View = "main" | "settings" | "detail" | "downloads" | "profile" | "explore";

interface DownloadProgress {
  id: string;
  label: string;
  downloaded: number;
  total: number;
  percent: number;
}

interface DownloadComplete {
  id: string;
  output_path: string;
}

interface DownloadError {
  id: string;
  error: string;
}

/** download://state 事件载荷：任务状态变化（queued/downloading/paused/cancelled） */
interface DownloadStateChange {
  id: string;
  status: "queued" | "downloading" | "paused" | "cancelled";
}

export default function App() {
  const [currentView, setCurrentView] = useState<View>("main");
  const [previousView, setPreviousView] = useState<View>("main");
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const [captchaVoucher, setCaptchaVoucher] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ParsedItem | null>(null);
  const downloadingIds = useRef<Set<string>>(new Set());
  // 每个下载任务最近一次进度落库的时间戳，用于节流，避免高频争抢 SQLite 锁
  const lastProgressWrite = useRef<Map<string, number>>(new Map());

  // 分页 state
  const [parsePage, setParsePage] = useState(1);
  const [parseTotal, setParseTotal] = useState(0);
  const [downloadPage, setDownloadPage] = useState(1);
  const [downloadTotal, setDownloadTotal] = useState(0);

  const { phase, updateInfo } = useUpdate();
  const { settings, save } = useSettings();
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

  // 下载事件监听（使用 mounted ref 防止卸载后更新状态）
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const fns = await Promise.all([
        listen<DownloadProgress>("download://progress", (event) => {
          if (cancelled) return;
          const { id, percent, label } = event.payload;
          const phase = label === "audio" ? "audio" as const : "video" as const;
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "downloading" as const, progress: percent, phase } : d
            )
          );
          // 节流写库：每个 id 至少间隔 DOWNLOAD_PROGRESS_THROTTLE_MS 落一次进度
          // （完成时由 complete 事件负责最终落库），避免并行分片高频触发
          // update_download_status 造成 SQLite 锁竞争与 UI 卡顿。
          const now = Date.now();
          const last = lastProgressWrite.current.get(id) ?? 0;
          if (now - last >= DOWNLOAD_PROGRESS_THROTTLE_MS) {
            lastProgressWrite.current.set(id, now);
            invoke("update_download_status", { id, status: "downloading", progress: percent, phase, errorMsg: null, outputPath: null }).catch(() => {});
          }
        }),
        listen<DownloadComplete>("download://complete", (event) => {
          if (cancelled) return;
          const { id, output_path } = event.payload;
          downloadingIds.current.delete(id);
          lastProgressWrite.current.delete(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "done" as const, progress: 100 } : d
            )
          );
          invoke("update_download_status", { id, status: "done", progress: 100, phase: null, errorMsg: null, outputPath: output_path }).catch(() => {});
        }),
        listen<DownloadError>("download://error", (event) => {
          if (cancelled) return;
          const { id, error } = event.payload;
          downloadingIds.current.delete(id);
          lastProgressWrite.current.delete(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "error" as const, errorMsg: error } : d
            )
          );
          invoke("update_download_status", { id, status: "error", progress: null, phase: null, errorMsg: error, outputPath: null }).catch(() => {});
          toast.error(`下载失败：${error}`);
        }),
        listen<{ v_voucher: string }>("download://risk_control", (event) => {
          if (cancelled) return;
          console.warn("[risk] 收到风控事件");
          setCaptchaVoucher(event.payload.v_voucher);
          toast.error("触发风控验证，请完成验证后重试");
        }),
        listen<DownloadStateChange>("download://state", (event) => {
          if (cancelled) return;
          const { id, status } = event.payload;
          if (status === "downloading") {
            // dispatcher 拿到 permit 开始执行：UI 从 queued → downloading
            setDownloads((prev) =>
              prev.map((d) => (d.id === id ? { ...d, status: "downloading" as const } : d))
            );
            invoke("update_download_status", { id, status: "downloading", progress: null, phase: null, errorMsg: null, outputPath: null }).catch(() => {});
          } else if (status === "paused") {
            downloadingIds.current.delete(id);
            lastProgressWrite.current.delete(id);
            setDownloads((prev) =>
              prev.map((d) => (d.id === id ? { ...d, status: "paused" as const } : d))
            );
            invoke("update_download_status", { id, status: "paused", progress: null, phase: null, errorMsg: null, outputPath: null }).catch(() => {});
          } else if (status === "cancelled") {
            downloadingIds.current.delete(id);
            lastProgressWrite.current.delete(id);
            // 取消即从列表移除（.tmp 已被后端清理，记录也删除）
            setDownloads((prev) => prev.filter((d) => d.id !== id));
            invoke("delete_download_history", { id }).catch(() => {});
          }
        }),
      ]);
      if (cancelled) {
        fns.forEach((fn) => fn());
      } else {
        unlisteners.push(...fns);
      }
    };

    setup();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [toast]);

  const hasUpdate = phase === "available" && updateInfo;
  const activeDownloads = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;

  const handleSaveSettings = async (s: AppSettings) => {
    await save(s);
  };

  const handleParse = async (url: string) => {
    const id = Date.now().toString();
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
    videoMeta?: VideoMeta
  ) => {
    // 用 ref 防止重复提交（queued/downloading 都算活跃，禁止重复）
    if (downloadingIds.current.has(id)) return;
    downloadingIds.current.add(id);

    // 先加入 UI 列表（显示为 queued，dispatcher 拿到 permit 后会 emit downloading）。
    // 同时填充恢复/重试所需的原始参数。
    setDownloads((prev) => {
      const filtered = prev.filter((d) => d.id !== id);
      return [{
        id, title, status: "queued" as const, progress: 0, pic,
        bvid, cid, epId: epId ?? null, videoTitle, duration,
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
        quality: null, video_title: videoTitle || null,
      }
    }).catch(() => {});

    // 提交到调度器（立即返回；下载中途状态/进度/完成/失败全走事件）。
    // 命令返回的 Err 仅代表提交阶段失败（如未登录）。
    try {
      await invoke("download_video", { id, bvid, cid, title, videoTitle, epId, duration, subtitleOnly, videoMeta });
      // downloadingIds 在 download://complete/error/state(cancelled) 中清理
    } catch (err) {
      downloadingIds.current.delete(id);
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, status: "error" as const, errorMsg: friendlyError(err) } : d
        )
      );
      toast.error(`下载失败：${friendlyError(err)}`);
    }
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
    handleDownload(
      item.id, item.bvid, item.cid, item.title, item.videoTitle || item.title,
      item.epId ?? undefined, item.duration, item.pic
    );
  };

  // 重试失败的任务（与恢复同：用原参数重新提交）
  const handleRetry = (item: DownloadTask) => {
    if (!item.bvid || item.cid === undefined) {
      toast.error("重试失败：缺少下载参数");
      return;
    }
    handleDownload(
      item.id, item.bvid, item.cid, item.title, item.videoTitle || item.title,
      item.epId ?? undefined, item.duration, item.pic
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

  // 详情页返回逻辑：回到来源页，保留其 state（来源页组件未被卸载）
  // 返回时保持当前页码（修复：原先强制回到第 1 页，丢失用户的分页位置）
  const handleDetailBack = () => {
    const prev = previousView;
    setCurrentView(prev);
    setSelectedItem(null);
    if (prev === "main") loadParsePage(parsePage);
  };

  // 视频详情覆盖层：无论当前在哪个视图都叠在最上层。
  // 关键：来源页组件保持挂载不被卸载，返回时其 state（搜索结果、UP 主投稿列表、
  // 收藏夹视频等）完整保留，避免返回后回到空白初始页。
  const detailOverlay =
    currentView === "detail" && selectedItem ? (
      <div className="fixed inset-0 z-50 bg-gray-50">
        <VideoDetail
          entry={selectedItem}
          onBack={handleDetailBack}
          onDownload={handleDownload}
        />
      </div>
    ) : null;

  // Settings view
  if (currentView === "settings") {
    return (
      <>
        <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
          <SettingsPage
            settings={settings}
            onSave={handleSaveSettings}
            onBack={() => setCurrentView("main")}
            onClearParse={() => loadParsePage(1)}
            onClearDownload={() => loadDownloadPage(1)}
          />
        </div>
        {detailOverlay}
      </>
    );
  }

  // Downloads view
  if (currentView === "downloads") {
    return (
      <>
        <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 bg-white">
            <button
              onClick={() => setCurrentView("main")}
              className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <Download size={16} className="rotate-180" />
            </button>
            <h1 className="text-lg font-semibold text-gray-800">下载列表</h1>
            {activeDownloads > 0 && (
              <span className="text-xs text-blue-500 font-medium">
                {activeDownloads} 个任务进行中
              </span>
            )}
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
          onSelectItem={(videoInfo: ParsedVideoInfo) => {
            // 直接用解析好的 videoInfo 跳转详情
            const item: ParsedItem = {
              id: `fav-${videoInfo.bvid}`,
              url: `https://www.bilibili.com/video/${videoInfo.bvid}`,
              title: videoInfo.title,
              status: "pending",
              videoInfo,
            };
            if (videoInfo.bvid) {
              invoke("touch_parse_history", { bvid: videoInfo.bvid }).catch(() => {});
            }
            setSelectedItem(item);
            setPreviousView("profile");
            setCurrentView("detail");
          }}
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
          onSelectItem={(videoInfo: ParsedVideoInfo) => {
            const item: ParsedItem = {
              id: `explore-${videoInfo.bvid}`,
              url: videoInfo.bvid
                ? `https://www.bilibili.com/video/${videoInfo.bvid}`
                : "",
              title: videoInfo.title,
              status: "pending",
              videoInfo,
            };
            if (videoInfo.bvid) {
              invoke("touch_parse_history", { bvid: videoInfo.bvid }).catch(() => {});
            }
            setSelectedItem(item);
            setPreviousView("explore");
            setCurrentView("detail");
          }}
        />
        {detailOverlay}
      </>
    );
  }

  // Main view
  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-800">BilbliCopy</h1>
          <span className="text-xs text-gray-400">v{version}</span>
          {/* 设置按钮（紧跟版本号） */}
          <div className="relative">
            <button
              onClick={() => setCurrentView("settings")}
              title="设置"
              className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
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
          {/* 发现入口 */}
          <button
            onClick={() => setCurrentView("explore")}
            title="发现"
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <Search size={16} />
          </button>

          {/* 下载列表入口 */}
          <div className="relative">
            <button
              onClick={() => setCurrentView("downloads")}
              title="下载列表"
              className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <Download size={16} />
            </button>
            {activeDownloads > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-blue-500 text-white text-[10px] font-medium px-1">
                {activeDownloads}
              </span>
            )}
          </div>

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
      <div className="px-6 py-3 bg-white border-b border-gray-100">
        <DownloadInput onParse={handleParse} isParsing={isParsing} />
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

      {detailOverlay}
    </div>
  );
}
