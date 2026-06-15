import { useEffect, useState, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

/** 读取系统深色偏好（SSR/无 matchMedia 时回退浅色） */
function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** 将"是否深色"应用到 <html>：切换 .dark 类 + color-scheme + localStorage 镜像 */
function applyDark(dark: boolean) {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  try {
    localStorage.setItem(STORAGE_KEY, lastMode);
  } catch {
    /* ignore */
  }
}

// 记录当前模式，供 applyDark 写入 localStorage（闭包外保持最新值）
let lastMode: ThemeMode = "light";

/**
 * 主题应用 Hook。
 * @param mode 用户偏好 "light" | "dark" | "system"
 * @param setMode 持久化回调（写入 settings）
 * @returns { resolved: 解析后的实际主题, toggle: 在 light↔dark 间翻转（不影响 system 偏好的存储语义，直接落定具体值） }
 */
export function useThemeApplier(
  mode: string,
  setMode: (m: ThemeMode) => void
): { resolved: "light" | "dark"; toggle: () => void } {
  const [resolved, setResolved] = useState<"light" | "dark">(() => {
    lastMode = (mode as ThemeMode) || "light";
    return lastMode === "dark" || (lastMode === "system" && systemPrefersDark())
      ? "dark"
      : "light";
  });

  // 应用模式变化
  useEffect(() => {
    const m: ThemeMode = (mode as ThemeMode) || "light";
    lastMode = m;
    const dark = m === "dark" || (m === "system" && systemPrefersDark());
    setResolved(dark ? "dark" : "light");
    applyDark(dark);
  }, [mode]);

  // 仅 system 模式下监听系统主题变化
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      lastMode = "system";
      setResolved(e.matches ? "dark" : "light");
      applyDark(e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  // 快捷切换：基于当前解析结果在 light↔dark 间翻转，落定具体模式（脱离 system）
  const toggle = useCallback(() => {
    const next: ThemeMode = resolved === "dark" ? "light" : "dark";
    setMode(next);
  }, [resolved, setMode]);

  return { resolved, toggle };
}
