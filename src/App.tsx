import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DownloadInput } from "./components/DownloadInput";
import { DownloadList } from "./components/DownloadList";
import { SettingsPage } from "./components/SettingsPage";
import { LoginDialog } from "./components/LoginDialog";
import { UserProfile } from "./components/UserProfile";
import { useUpdate } from "./contexts/UpdateContext";
import { useSettings } from "./hooks/useSettings";
import { useLogin } from "./hooks/useLogin";
import { Settings } from "lucide-react";
import type { AppSettings } from "./hooks/useSettings";
import type { DownloadEntry, ParsedVideoInfo } from "./types";

type View = "main" | "settings";

export default function App() {
  const [currentView, setCurrentView] = useState<View>("main");
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [isParsing, setIsParsing] = useState(false);

  const { phase, updateInfo } = useUpdate();
  const { settings, save } = useSettings();
  const { userInfo, logout, generateQrcode, pollQrcode } = useLogin();
  const [version, setVersion] = useState("");
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  const hasUpdate = phase === "available" && updateInfo;

  const handleSaveSettings = async (s: AppSettings) => {
    await save(s);
  };

  const handleParse = async (url: string) => {
    const id = Date.now().toString();
    const entry: DownloadEntry = {
      id,
      url,
      title: url,
      status: "parsing",
    };
    setDownloads((prev) => [entry, ...prev]);
    setIsParsing(true);

    try {
      const videoInfo = await invoke<ParsedVideoInfo>("parse_video", { url });
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === id
            ? { ...d, title: videoInfo.title, status: "pending" as const, videoInfo }
            : d
        )
      );
    } catch (err) {
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === id
            ? { ...d, status: "error" as const, errorMsg: String(err) }
            : d
        )
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleRemove = (id: string) => {
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
            <div className="relative">
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

      {/* 下载列表 */}
      <div className="flex-1 overflow-auto px-6 py-2">
        <DownloadList downloads={downloads} onRemove={handleRemove} />
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
