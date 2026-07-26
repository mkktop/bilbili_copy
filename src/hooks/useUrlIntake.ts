import { useEffect, useRef } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * B 站链接识别正则表（与后端 bilibili/url.rs 接受的输入对齐）。
 * 顺序敏感：完整 URL 优先匹配，裸 BV 号兜底（避免从长文本里截出无上下文的 BV）。
 */
const URL_PATTERNS: RegExp[] = [
  /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10,}|av\d+)/i,
  /https?:\/\/(?:www\.)?bilibili\.com\/bangumi\/play\/(?:ep|ss)\d+/i,
  /https?:\/\/b23\.tv\/[0-9A-Za-z]+/i,
  /\bBV[0-9A-Za-z]{10,}/,
];

/** 从任意文本中提取第一个 B 站链接/BV 号；无命中返回 null */
export function extractBiliUrl(text: string): string | null {
  if (!text) return null;
  for (const re of URL_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

interface UrlIntakeOptions {
  /** 识别到新链接时的回调（填入解析输入框） */
  onUrl: (url: string) => void;
  /** 剪贴板探测门控：返回 false 时 focus 不读剪贴板（如不在主视图）。拖放不受此限。 */
  clipboardEnabled: () => boolean;
}

/**
 * 链接摄取 Hook：两条入口把 B 站链接送进解析输入框。
 *
 * 1. 窗口获得焦点 → 读剪贴板 → 命中且与上次摄取不同 → onUrl（下载器标志性体验：
 *    复制分享链接后切回应用即自动填入）。启动后首次 focus 即生效是预期行为。
 * 2. 拖拽链接文本入窗 → onUrl（从任意视图都生效，调用方负责切回主视图）。
 *    拖到 input/textarea 上时放行原生行为，不拦截。
 *
 * 去重按「提取后的匹配」而非原始剪贴板文本：同一链接反复切窗不会重复填；
 * 用户解析成功后清空输入框也不影响去重（想重填需复制新内容或新链接）。
 */
export function useUrlIntake({ onUrl, clipboardEnabled }: UrlIntakeOptions): void {
  // 回调经 ref 转发：监听器只注册一次，始终调最新回调
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;
  const enabledRef = useRef(clipboardEnabled);
  enabledRef.current = clipboardEnabled;
  // 上次摄取的链接（提取后的匹配），防重复填
  const lastIntakeRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const intake = (text: string) => {
      const url = extractBiliUrl(text);
      if (!url || url === lastIntakeRef.current) return;
      lastIntakeRef.current = url;
      onUrlRef.current(url);
    };

    const onFocus = async () => {
      if (!enabledRef.current()) return;
      try {
        const text = await readText();
        if (!disposed && text) intake(text);
      } catch {
        // 剪贴板被占用 / 无内容 / 权限异常：静默（读取剪贴板是 best-effort）
      }
    };

    const onDragOver = (e: DragEvent) => {
      // 必须 preventDefault，drop 事件才会触发
      e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      // 拖进输入框/文本域：保留原生文本插入行为，不拦截也不 preventDefault
      const target = e.target as HTMLElement | null;
      const intoField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (!intoField) {
        // 必须拦截默认行为：dragDropEnabled:false 下 WebView2 对拖入文件的默认处理是
        // 导航到该文件 —— 会把整个 SPA 导航掉。无论拖进来的是链接还是文件都要 preventDefault。
        e.preventDefault();
      }
      if (intoField) return;
      const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
      if (!text) return;
      // 多行（如 uri-list 多个链接）取首个命中
      for (const line of text.split(/\r?\n/)) {
        const url = extractBiliUrl(line);
        if (url) {
          if (url !== lastIntakeRef.current) {
            lastIntakeRef.current = url;
            onUrlRef.current(url);
          }
          return;
        }
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
}
