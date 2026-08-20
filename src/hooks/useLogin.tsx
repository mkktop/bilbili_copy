import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface UserInfo {
  mid: number;
  uname: string;
  face: string;
  level: number;
  coins: number;
  sign: string;
  vip: boolean;
  following: number;
  follower: number;
  sex: string;
}

export type QrPollStatus = "pending" | "scanned" | "confirmed" | "expired";

export interface QrCodeResult {
  url: string;
  qrcode_key: string;
}

export interface QrPollResult {
  status: QrPollStatus;
  user_info: UserInfo | null;
}

interface LoginApi {
  userInfo: UserInfo | null;
  loading: boolean;
  logout: () => Promise<void>;
  generateQrcode: () => Promise<QrCodeResult>;
  pollQrcode: (qrcodeKey: string) => Promise<QrPollResult>;
}

/**
 * 登录态全局 Context。
 * 旧实现是普通 hook：每个调用点各自 useState + 各自 login_check，多份实例互不同步
 * （App 登录成功后 InteractionBar 仍显示未登录，点赞/投币全部误报"请先登录"；
 * 登出后反向不同步），且每打开一个详情页多一次 login_check 网络请求。
 * 必须在 <LoginProvider> 内使用（main.tsx 已包裹，与 UpdateProvider 同层级）。
 */
const LoginContext = createContext<LoginApi | null>(null);

export function LoginProvider({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 启动时自动检查登录状态（整个应用只跑一次）
  useEffect(() => {
    (async () => {
      try {
        const info = await invoke<UserInfo | null>("login_check");
        setUserInfo(info);
      } catch {
        // 未登录或错误
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const logout = useCallback(async () => {
    try {
      await invoke("login_logout");
    } catch (err) {
      console.error("登出失败:", err);
    }
    setUserInfo(null);
  }, []);

  const generateQrcode = useCallback(async (): Promise<QrCodeResult> => {
    return invoke<QrCodeResult>("login_generate_qrcode");
  }, []);

  const pollQrcode = useCallback(
    async (qrcodeKey: string): Promise<QrPollResult> => {
      const result = await invoke<QrPollResult>("login_poll_qrcode", {
        qrcodeKey,
      });
      if (result.status === "confirmed" && result.user_info) {
        setUserInfo(result.user_info);
      }
      return result;
    },
    []
  );

  return (
    <LoginContext.Provider value={{ userInfo, loading, logout, generateQrcode, pollQrcode }}>
      {children}
    </LoginContext.Provider>
  );
}

export function useLogin(): LoginApi {
  const ctx = useContext(LoginContext);
  if (!ctx) {
    throw new Error("useLogin 必须在 <LoginProvider> 内使用");
  }
  return ctx;
}
