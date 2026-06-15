import { useState } from "react";
import { LogOut, X } from "lucide-react";
import type { UserInfo } from "../hooks/useLogin";

interface UserProfileProps {
  userInfo: UserInfo;
  onLogout: () => Promise<void>;
  onClose: () => void;
}

export function UserProfile({ userInfo, onLogout, onClose }: UserProfileProps) {
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
      onClose();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="absolute right-0 top-full mt-2 w-64 bg-panel border border-line rounded-xl shadow-lg z-50 p-4">
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 p-1 rounded-md text-ink-3 hover:text-ink-2 hover:bg-panel-2"
      >
        <X size={14} />
      </button>

      {/* 头像 + 用户信息 */}
      <div className="flex items-center gap-3 mb-4">
        <img
          src={userInfo.face}
          alt={userInfo.uname}
          className="w-12 h-12 rounded-full object-cover border border-line"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink truncate">
            {userInfo.uname}
          </p>
          <p className="text-xs text-ink-3">UID: {userInfo.mid}</p>
        </div>
      </div>

      {/* 退出登录按钮 */}
      <button
        onClick={handleLogout}
        disabled={loggingOut}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
      >
        <LogOut size={14} />
        {loggingOut ? "退出中..." : "退出登录"}
      </button>
    </div>
  );
}
