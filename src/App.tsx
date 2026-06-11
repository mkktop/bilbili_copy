import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DownloadInput } from "./components/DownloadInput";
import { DownloadList } from "./components/DownloadList";
import { ParseList } from "./components/ParseList";
import { VideoDetail } from "./components/VideoDetail";
import { SettingsPage } from "./components/SettingsPage";
import { LoginDialog } from "./components/LoginDialog";
import { UserProfile } from "./components/UserProfile";
import { useUpdate } from "./contexts/UpdateContext";
import { useSettings } from "./hooks/useSettings";
import { useLogin } from "./hooks/useLogin";
import { Settings, Download } from "lucide-react";
import type { AppSettings } from "./hooks/useSettings";
import type { ParsedItem, DownloadTask, ParsedVideoInfo } from "./types";

type View = "main" | "settings" | "detail" | "downloads";

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
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ParsedItem | null>(null);
  const downloadingIds = useRef<Set<string>>(new Set());

  const { phase, updateInfo } = useUpdate();
  const { settings, save } = useSettings();
  const { userInfo, logout, generateQrcode, pollQrcode } = useLogin();
  const [version, setVersion] = useState("");
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // 用于 UserProfile 外部点击关闭
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  // UserProfile 外部点击关闭
  useEffect(() => {
    if (!profileOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileOpen]);

  // 下载事件监听（使用 mounted ref 防止卸载后更新状态）
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const fns = await Promise.all([
        listen<DownloadProgress>("download://progress", (event) => {
          if (cancelled) return;
          const { id, percent } = event.payload;
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "downloading" as const, progress: percent } : d
            )
          );
        }),
        listen<DownloadComplete>("download://complete", (event) => {
          if (cancelled) return;
          const { id } = event.payload;
          downloadingIds.current.delete(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "done" as const, progress: 100 } : d
            )
          );
        }),
        listen<DownloadError>("download://error", (event) => {
          if (cancelled) return;
          const { id } = event.payload;
          downloadingIds.current.delete(id);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, status: "error" as const, errorMsg: event.payload.error } : d
            )
          );
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
    } catch (err) {
      setParsedItems((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, status: "error" as const, errorMsg: String(err) }
            : p
        )
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleDownload = async (
    id: string,
    bvid: string,
    cid: number,
    title: string,
    qn: number = 80
  ) => {
    // 用 ref 防止重复提交（不受 React 批量更新影响）
    if (downloadingIds.current.has(id)) return;
    downloadingIds.current.add(id);

    setDownloads((prev) => [
      { id, title, status: "downloading" as const, progress: 0 },
      ...prev,
    ]);

    try {
      await invoke("download_video", { id, bvid, cid, title, qn });
      // 注意：downloadingIds 在 download://complete 事件中清理，不在此时清理
      // 因为 invoke 返回时后端可能仍在发送进度事件
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
    setSelectedItem(item);
    setCurrentView("detail");
  };

  const handleRemoveParsed = (id: string) => {
    setParsedItems((prev) => prev.filter((p) => p.id !== id));
  };

  const handleRemoveDownload = (id: string) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  };

  // Settings view
  if (currentView === "settings") {
    return (
      <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
        <SettingsPage
          settings={settings}
          onSave={handleSaveSettings}
          onBack={() => setCurrentView("main")}
        />
      </div>
    );
  }

  // Downloads view
  if (currentView === "downloads") {
    return (
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
          <DownloadList downloads={downloads} onRemove={handleRemoveDownload} />
        </div>
      </div>
    );
  }

  // Detail view
  if (currentView === "detail" && selectedItem) {
    return (
      <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
        <VideoDetail
          entry={selectedItem}
          onBack={() => {
            setCurrentView("main");
            setSelectedItem(null);
          }}
          onDownload={handleDownload}
          defaultQn={settings.video_max_quality || 80}
        />
      </div>
    );
  }

  // Main view
  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-800">B站视频下载</h1>
          <span className="text-xs text-gray-400">v{version}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* 登录按钮 / 头像 */}
          {userInfo ? (
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="p-0.5 rounded-full hover:ring-2 hover:ring-blue-300 transition-all"
              >
                <img
                  src={userInfo.face}
                  alt={userInfo.uname}
                  className="w-7 h-7 rounded-full object-cover"
                />
              </button>
              {profileOpen && (
                <UserProfile
                  userInfo={userInfo}
                  onLogout={logout}
                  onClose={() => setProfileOpen(false)}
                />
              )}
            </div>
          ) : (
            <button
              onClick={() => setLoginDialogOpen(true)}
              className="px-3 py-1 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors"
            >
              登录
            </button>
          )}

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

          {/* 设置按钮 */}
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
    </div>
  );
}
