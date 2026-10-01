import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Settings, Minus, Square, X, Copy, Sun, Moon } from "lucide-react";

const avatarUrl = new URL("../assets/avatar.png", import.meta.url).href;

interface TitleBarProps {
  version: string;
  /** 有可用更新时给设置按钮加绿点 */
  hasUpdate: boolean;
  resolvedTheme: string;
  toggleTheme: () => void;
  onSettings: () => void;
}

/**
 * 无边框窗口（decorations: false）的自绘标题栏：
 * 左侧品牌 + 设置入口，中部整条拖动区（双击最大化），右侧主题切换与 Windows 风格窗口控制。
 * 关闭按钮走 window.close() → 后端 CloseRequested 拦截 → 与原生关闭一样隐藏到托盘。
 */
export function TitleBar({ version, hasUpdate, resolvedTheme, toggleTheme, onSettings }: TitleBarProps) {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized).catch(() => {});
    let unlisten: (() => void) | null = null;
    win
      .onResized(async () => {
        try {
          setMaximized(await win.isMaximized());
        } catch {
          /* 窗口销毁时忽略 */
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [win]);

  return (
    <div className="relative flex items-stretch h-10 shrink-0 select-none">
      {/* 品牌区（可拖动） */}
      <div data-tauri-drag-region className="flex items-center gap-2 pl-4 pr-2">
        <img src={avatarUrl} alt="" className="h-[20px] w-[20px] rounded-full" draggable={false} />
        <span className="text-sm font-bold text-ink">未雨</span>
        <span className="text-[11px] text-ink-3">v{version}</span>
        <div className="relative">
          <button
            onClick={onSettings}
            title="设置"
            className="p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
          >
            <Settings size={15} />
          </button>
          {hasUpdate && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500" />
          )}
        </div>
      </div>

      {/* 中部拖动区（双击切换最大化） */}
      <div data-tauri-drag-region className="flex-1" />

      {/* 主题切换 */}
      <div className="flex items-center px-2">
        <button
          onClick={toggleTheme}
          title={resolvedTheme === "dark" ? "切换到浅色" : "切换到深色"}
          className="p-1.5 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
        >
          {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {/* 窗口控制：Windows 风格矩形热区，关闭悬停变红 */}
      <button
        onClick={() => win.minimize()}
        title="最小化"
        aria-label="最小化"
        className="w-[46px] flex items-center justify-center text-ink-3 hover:bg-panel-2 hover:text-ink-2 transition-colors"
      >
        <Minus size={15} />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        className="w-[46px] flex items-center justify-center text-ink-3 hover:bg-panel-2 hover:text-ink-2 transition-colors"
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button
        onClick={() => win.close()}
        title="关闭"
        aria-label="关闭"
        className="w-[46px] flex items-center justify-center text-ink-3 hover:bg-red-500 hover:text-white transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}
