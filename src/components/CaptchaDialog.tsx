import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, Loader2, AlertCircle } from "lucide-react";

interface CaptchaDialogProps {
  vVoucher: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}

interface CaptchaInfo {
  token: string;
  gt: string;
  challenge: string;
}

// GeeTest v3 类型声明
interface GeeTestObj {
  onReady: (cb: () => void) => void;
  onSuccess: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  getValidate: () => { geetest_challenge: string; geetest_validate: string; geetest_seccode: string } | undefined;
  appendTo: (el: HTMLElement | string) => void;
  destroy: () => void;
}

declare global {
  interface Window {
    initGeetest: (config: {
      gt: string;
      challenge: string;
      offline: boolean;
      new_captcha: boolean;
      product: string;
      width: string;
    }, callback: (obj: GeeTestObj) => void) => void;
  }
}

export function CaptchaDialog({ vVoucher, onSuccess, onCancel }: CaptchaDialogProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "validating" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const captchaRef = useRef<HTMLDivElement>(null);
  const captchaInfoRef = useRef<CaptchaInfo | null>(null);
  const captchaObjRef = useRef<GeeTestObj | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!vVoucher) return;

    let cancelled = false;

    async function initCaptcha() {
      try {
        const info = await invoke<CaptchaInfo>("captcha_register", { vVoucher });
        if (cancelled) return;

        captchaInfoRef.current = info;

        if (!window.initGeetest) {
          setErrorMsg("GeeTest SDK 加载失败，请检查网络");
          setStatus("error");
          return;
        }

        window.initGeetest(
          {
            gt: info.gt,
            challenge: info.challenge,
            offline: false,
            new_captcha: true,
            product: "bind",
            width: "300px",
          },
          (captchaObj) => {
            captchaObjRef.current = captchaObj;
            captchaObj.onReady(() => {
              if (!cancelled) setStatus("ready");
            });

            captchaObj.onSuccess(async () => {
              if (!cancelled) {
                setStatus("validating");
                const result = captchaObj.getValidate();
                if (!result) {
                  setErrorMsg("验证结果获取失败");
                  setStatus("error");
                  return;
                }

                try {
                  await invoke("captcha_validate", {
                    challenge: result.geetest_challenge,
                    token: info.token,
                    validate: result.geetest_validate,
                    seccode: result.geetest_seccode,
                  });
                  setStatus("success");
                  successTimerRef.current = setTimeout(() => onSuccess(), 500);
                } catch (err) {
                  setErrorMsg(String(err));
                  setStatus("error");
                }
              }
            });

            captchaObj.onError(() => {
              if (!cancelled) {
                setErrorMsg("验证码加载出错");
                setStatus("error");
              }
            });

            // 自动弹出验证码
            if (captchaRef.current) {
              captchaRef.current.innerHTML = "";
              captchaObj.appendTo(captchaRef.current);
            }
          }
        );
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(String(err));
          setStatus("error");
        }
      }
    }

    initCaptcha();
    return () => {
      cancelled = true;
      // 清理 GeeTest 实例（DOM、事件监听、弹层），避免重开/卸载时泄漏
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
      const obj = captchaObjRef.current;
      if (obj) {
        try {
          obj.destroy();
        } catch {
          // destroy 可能在 SDK 未就绪时抛错，忽略
        }
        captchaObjRef.current = null;
      }
      if (captchaRef.current) {
        captchaRef.current.innerHTML = "";
      }
    };
  }, [vVoucher]);

  if (!vVoucher) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-panel rounded-2xl shadow-xl w-80 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-blue-500" />
            <h3 className="text-sm font-semibold text-ink">安全验证</h3>
          </div>
          <p className="text-xs text-ink-3 mt-1">完成验证后继续下载</p>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          {status === "loading" && (
            <div className="flex items-center justify-center py-6 gap-2">
              <Loader2 size={16} className="animate-spin text-blue-500" />
              <span className="text-sm text-ink-3">加载验证码...</span>
            </div>
          )}

          {status === "validating" && (
            <div className="flex items-center justify-center py-6 gap-2">
              <Loader2 size={16} className="animate-spin text-green-500" />
              <span className="text-sm text-ink-3">验证中...</span>
            </div>
          )}

          {status === "success" && (
            <div className="flex items-center justify-center py-6 gap-2">
              <ShieldCheck size={16} className="text-green-500" />
              <span className="text-sm text-green-600 font-medium">验证成功</span>
            </div>
          )}

          {status === "error" && (
            <div className="py-4">
              <div className="flex items-start gap-2 text-red-500 mb-3">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="text-xs">{errorMsg}</span>
              </div>
              <button
                onClick={onCancel}
                className="w-full py-2 text-xs text-ink-3 hover:text-ink-2 border border-line rounded-lg"
              >
                关闭
              </button>
            </div>
          )}

          {/* GeeTest 容器 */}
          {(status === "ready" || status === "error") && (
            <div ref={captchaRef} className="flex justify-center" />
          )}
        </div>
      </div>
    </div>
  );
}
