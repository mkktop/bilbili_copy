import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { TOAST_DURATION_MS } from "../lib/constants";
import { cn } from "../lib/utils";

/**
 * 极简 toast 系统（零依赖）。
 * - ToastProvider 包裹根组件
 * - useToast() 暴露 success / error / info
 * - 顶部居中固定，自动消失，可手动关闭
 */

export type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TYPE_CONFIG: Record<
  ToastType,
  { icon: ReactNode; color: string; border: string; bg: string }
> = {
  success: {
    icon: <CheckCircle2 size={16} className="text-green-500" />,
    color: "text-ink-2",
    border: "border-green-200",
    bg: "bg-panel",
  },
  error: {
    icon: <XCircle size={16} className="text-red-500" />,
    color: "text-ink-2",
    border: "border-red-200",
    bg: "bg-panel",
  },
  info: {
    icon: <Info size={16} className="text-accent" />,
    color: "text-ink-2",
    border: "border-line",
    bg: "bg-panel",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // 自增 id，避免快速连发时 key 冲突
  const idRef = useRef(0);
  // 记录每个 toast 的自动消失定时器，便于提前关闭时清理
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (type: ToastType, message: string) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, type, message }]);
      const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
          {toasts.map((t) => {
            const cfg = TYPE_CONFIG[t.type];
            return (
              <div
                key={t.id}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 rounded-lg border shadow-lg max-w-md pointer-events-auto",
                  "animate-[fadeIn_0.15s_ease-out]",
                  cfg.bg,
                  cfg.border
                )}
              >
                {cfg.icon}
                <span className={cn("text-sm", cfg.color)}>{t.message}</span>
                <button
                  onClick={() => dismiss(t.id)}
                  className="ml-1 p-0.5 rounded text-ink-3 hover:text-ink-2 transition-colors shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

/** 获取 toast api。必须在 ToastProvider 内部使用。 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 ToastProvider 内部使用");
  }
  return ctx;
}
