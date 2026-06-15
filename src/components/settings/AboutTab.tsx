import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Video,
  ExternalLink,
  RefreshCw,
  Download,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useUpdate } from "../../contexts/UpdateContext";
import type { AppSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";

const GITHUB_URL = "https://github.com/mkk/bilbili_copy";

interface AboutTabProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function AboutTab({ settings, onSave }: AboutTabProps) {
  const [version, setVersion] = useState("");
  const { phase, updateInfo, error, checkUpdate, installUpdate } = useUpdate();

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  const isChecking = phase === "checking";
  const isDownloading = phase === "downloading";
  const isUpToDate = phase === "upToDate";
  const hasUpdate = phase === "available" && updateInfo;
  const hasError = phase === "error";

  const handleAutoUpdateToggle = async () => {
    const next = !settings.auto_update;
    await onSave({ ...settings, auto_update: next });
  };

  return (
    <div className="space-y-6">
      {/* 应用信息卡片 */}
      <div className="rounded-xl border border-line bg-gradient-to-br from-panel to-panel-2 p-6 space-y-5 shadow-sm">
        {/* 应用名称和版本 */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Video size={24} />
          </div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-ink">B站视频下载</h2>
            {version && (
              <span className="px-2 py-0.5 rounded-full bg-accent-soft text-accent text-xs font-medium">
                v{version}
              </span>
            )}
          </div>
        </div>

        {/* 操作按钮行 */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => openUrl(GITHUB_URL)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-line-2 rounded-lg hover:bg-panel-2 transition-colors text-xs"
          >
            <ExternalLink size={14} />
            GitHub
          </button>

          <button
            onClick={checkUpdate}
            disabled={isChecking || isDownloading}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 border rounded-lg transition-colors text-xs",
              hasUpdate
                ? "border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
                : "border-line-2 hover:bg-panel-2"
            )}
          >
            <RefreshCw size={14} className={isChecking ? "animate-spin" : ""} />
            {isChecking ? "检查中..." : hasUpdate ? `发现 v${updateInfo!.version}` : "检查更新"}
          </button>

          {isUpToDate && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 size={14} />
              已是最新版本
            </span>
          )}

          {hasError && (
            <span className="flex items-center gap-1 text-xs text-red-500">
              <AlertCircle size={14} />
              {error}
            </span>
          )}
        </div>
      </div>

      {/* 更新可用横幅 */}
      {hasUpdate && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Download size={16} className="text-green-600" />
              <span className="text-sm font-medium text-green-700">
                发现新版本 v{updateInfo!.version}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={installUpdate}
                disabled={isDownloading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors text-xs font-medium"
              >
                {isDownloading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    正在下载...
                  </>
                ) : (
                  <>
                    <Download size={14} />
                    立即更新
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 更新日志 */}
          {updateInfo!.body && (
            <div className="pt-2 border-t border-green-200">
              <p className="text-xs font-medium text-green-700 mb-1">更新日志</p>
              <div className="text-xs text-green-600 whitespace-pre-wrap max-h-40 overflow-y-auto">
                {updateInfo!.body}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 下载中状态 */}
      {isDownloading && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-2 text-sm text-blue-700">
            <Loader2 size={16} className="animate-spin" />
            正在下载更新，请稍候...
          </div>
        </div>
      )}

      {/* 安装中状态 */}
      {phase === "installing" && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-2 text-sm text-blue-700">
            <Loader2 size={16} className="animate-spin" />
            正在安装更新，应用即将重启...
          </div>
        </div>
      )}

      {/* 自动更新开关 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">更新偏好</h3>
          <p className="text-xs text-ink-3">控制应用是否在启动时自动检查更新</p>
        </header>

        <div className="flex items-center justify-between rounded-xl border border-line bg-panel p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-ink-2">启动时自动检查更新</p>
            <p className="text-xs text-ink-3">关闭后需手动检查</p>
          </div>
          <button
            role="switch"
            aria-checked={settings.auto_update}
            onClick={handleAutoUpdateToggle}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
              settings.auto_update ? "bg-blue-500" : "bg-line-2"
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 rounded-full bg-white transform transition-transform shadow",
                settings.auto_update ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>
      </section>

      {/* 底部版权信息 */}
      <div className="pt-4 border-t border-line text-center">
        <p className="text-xs text-ink-3">
          B站视频下载 · 快速下载Bilibili视频
        </p>
      </div>
    </div>
  );
}
