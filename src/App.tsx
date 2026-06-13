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
import { useUpdate } from "./contexts/UpdateContext";
import { useSettings } from "./hooks/useSettings";
import { useLogin } from "./hooks/useLogin";
import { Settings, Download, Search } from "lucide-react";
import type { AppSettings } from "./hooks/useSettings";
import type { ParsedItem, DownloadTask, ParsedVideoInfo, ParseHistoryEntry, DownloadHistoryEntry } from "./types";
import { dbToParsedItem, dbToDownloadTask } from "./types";

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
      console.warn("加载解析历史失败:", e);
    }
  }, []);

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
      console.warn("加载下载历史失败:", e);
    }
  }, []);

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
          // 节流写库：每个 id 至少间隔 1.2s 落一次进度（完成时由 complete 事件负责最终落库），
          // 避免并行分片高频触发 update_download_status 造成 SQLite 锁竞争与 UI 卡顿。
          const now = Date.now();
          const last = lastProgressWrite.current.get(id) ?? 0;
          if (now - last >= 1200) {
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
        }),
        listen<{ v_voucher: string }>("download://risk_control", (event) => {
          if (cancelled) return;
          console.warn("[risk] 收到风控事件");
          setCaptchaVoucher(event.payload.v_voucher);
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
  }, []);

  const hasUpdate = phase === "available" && updateInfo;
  const activeDownloads = downloads.filter((d) => d.status === "downloading").length;

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
      // 持久化解析成功的记录
      invoke("save_parse_history", {
        entry: { id, url, bvid: videoInfo.bvid, title: videoInfo.title, video_info: videoInfo, parsed_at: new Date().toISOString() }
      }).then(() => loadParsePage(1)).catch(() => {});
      return videoInfo;
    } catch (err) {
      setParsedItems((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, status: "error" as const, errorMsg: String(err) }
            : p
        )
      );
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
    duration?: number
  ) => {
    // 用 ref 防止重复提交
    if (downloadingIds.current.has(id)) return;
    downloadingIds.current.add(id);

    // 先加入 UI 列表（显示为 downloading），如果同 ID 已存在则替换
    setDownloads((prev) => {
      const filtered = prev.filter((d) => d.id !== id);
      return [{ id, title, status: "downloading" as const, progress: 0 }, ...filtered];
    });

    // 持久化下载记录
    invoke("save_download_entry", {
      entry: { id, title, bvid, cid, ep_id: epId ?? null, status: "downloading", progress: 0, phase: null, error_msg: null, output_path: null, created_at: new Date().toISOString() }
    }).catch(() => {});

    // 直接 invoke，并发由 Rust 端 Semaphore 控制
    try {
      await invoke("download_video", { id, bvid, cid, title, videoTitle, epId, duration });
      // downloadingIds 在 download://complete 事件中清理
    } catch (err) {
      downloadingIds.current.delete(id);
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, status: "error" as const, errorMsg: String(err) } : d
        )
      );
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
    setParsedItems((prev) => prev.filter((p) => p.id !== id));
    invoke("delete_parse_history", { id }).then(() => loadParsePage(parsePage)).catch(() => {});
  };

  const handleRemoveDownload = (id: string) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
    invoke("delete_download_history", { id }).then(() => loadDownloadPage(downloadPage)).catch(() => {});
  };

  // 详情页返回逻辑：回到来源页，保留其 state（来源页组件未被卸载）
  const handleDetailBack = () => {
    const prev = previousView;
    setCurrentView(prev);
    setSelectedItem(null);
    if (prev === "main") loadParsePage(1);
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
