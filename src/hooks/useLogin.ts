import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface UserInfo {
  mid: number;
  uname: string;
  face: string;
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

export function useLogin() {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 启动时自动检查登录状态
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

  return { userInfo, loading, logout, generateQrcode, pollQrcode };
}
