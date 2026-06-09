import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import { X, Loader2, Smartphone, CheckCircle2, AlertCircle } from "lucide-react";
import type { QrCodeResult, QrPollStatus } from "../hooks/useLogin";

interface LoginDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  generateQrcode: () => Promise<QrCodeResult>;
  pollQrcode: (key: string) => Promise<{ status: QrPollStatus; user_info: unknown | null }>;
}

type DialogPhase =
  | "loading"
  | "polling"
  | "scanned"
  | "success"
  | "expired"
  | "error";

export function LoginDialog({
  open,
  onClose,
  onSuccess,
  generateQrcode,
  pollQrcode,
}: LoginDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>("loading");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const qrcodeKeyRef = useRef("");
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // 弹窗打开时生成二维码
  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    setPhase("loading");
    setErrorMsg("");
    setQrDataUrl("");

    (async () => {
      try {
        const result = await generateQrcode();
        qrcodeKeyRef.current = result.qrcode_key;
        const dataUrl = await QRCode.toDataURL(result.url, {
          width: 200,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        if (!mountedRef.current) return;
        setQrDataUrl(dataUrl);
        setPhase("polling");
      } catch (e) {
        if (!mountedRef.current) return;
        setErrorMsg(String(e));
        setPhase("error");
      }
    })();

    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [open, generateQrcode]);

  // 轮询循环
  useEffect(() => {
    if (phase !== "polling" && phase !== "scanned") return;

    const poll = async () => {
      if (!mountedRef.current || !qrcodeKeyRef.current) return;
      try {
        const result = await pollQrcode(qrcodeKeyRef.current);
        if (!mountedRef.current) return;

        switch (result.status) {
          case "pending":
            setPhase("polling");
            break;
          case "scanned":
            setPhase("scanned");
            break;
          case "confirmed":
            setPhase("success");
            setTimeout(() => onSuccess(), 800);
            return;
          case "expired":
            setPhase("expired");
            return;
        }
      } catch (e) {
        if (!mountedRef.current) return;
        setErrorMsg(String(e));
        setPhase("error");
        return;
      }

      pollTimerRef.current = setTimeout(poll, 3000);
    };

    pollTimerRef.current = setTimeout(poll, 1000);

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [phase, pollQrcode, onSuccess]);

  if (!open) return null;

  const statusText = (() => {
    switch (phase) {
      case "loading":
        return "正在生成二维码...";
      case "polling":
        return "请使用B站APP扫描二维码";
      case "scanned":
        return "扫描成功，请在手机上确认";
      case "success":
        return "登录成功！";
      case "expired":
        return "二维码已过期";
      case "error":
        return errorMsg || "发生错误";
    }
  })();

  const statusIcon = (() => {
    switch (phase) {
      case "loading":
      case "polling":
        return <Loader2 size={16} className="animate-spin text-blue-500" />;
      case "scanned":
        return <Smartphone size={16} className="text-blue-500" />;
      case "success":
        return <CheckCircle2 size={16} className="text-green-500" />;
      case "expired":
        return <AlertCircle size={16} className="text-orange-500" />;
      case "error":
        return <AlertCircle size={16} className="text-red-500" />;
    }
  })();

  const handleRetry = async () => {
    setPhase("loading");
    setErrorMsg("");
    try {
      const result = await generateQrcode();
      qrcodeKeyRef.current = result.qrcode_key;
      const dataUrl = await QRCode.toDataURL(result.url, {
        width: 200,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
      setPhase("polling");
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 w-80 relative">
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
        >
          <X size={16} />
        </button>

        <h2 className="text-base font-semibold text-gray-800 mb-4 text-center">
          B站账号登录
        </h2>

        {/* 二维码区域 */}
        <div className="flex justify-center mb-4">
          {phase === "loading" ? (
            <div className="w-[200px] h-[200px] flex items-center justify-center bg-gray-50 rounded-lg">
              <Loader2 size={32} className="animate-spin text-gray-300" />
            </div>
          ) : (
            <img
              src={qrDataUrl}
              alt="QR Code"
              className="w-[200px] h-[200px] rounded-lg"
            />
          )}
        </div>

        {/* 状态提示 */}
        <div className="flex items-center justify-center gap-2 text-sm text-gray-600">
          {statusIcon}
          <span>{statusText}</span>
        </div>

        {/* 过期时显示重新生成按钮 */}
        {phase === "expired" && (
          <div className="mt-3 flex justify-center">
            <button
              onClick={handleRetry}
              className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              重新生成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
