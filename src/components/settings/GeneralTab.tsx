import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Check, Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "../Toast";
import { friendlyError } from "../../lib/errors";

interface GeneralTabProps {
  dir: string;
  onDirChange: (dir: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onClearParse?: () => void;
  onClearDownload?: () => void;
}

export function GeneralTab({
  dir,
  onDirChange,
  saving,
  saved,
  onSave,
  onClearParse,
  onClearDownload,
}: GeneralTabProps) {
  const [clearing, setClearing] = useState<"parse" | "download" | null>(null);
  const toast = useToast();

  const handleClearParse = async () => {
    setClearing("parse");
    try {
      await invoke("clear_parse_history");
      onClearParse?.();
      toast.success("已清除解析记录");
    } catch (e) {
      toast.error(`清除失败：${friendlyError(e)}`);
    } finally {
      setClearing(null);
    }
  };

  const handleClearDownload = async () => {
    setClearing("download");
    try {
      await invoke("clear_download_history");
      onClearDownload?.();
      toast.success("已清除下载记录");
    } catch (e) {
      toast.error(`清除失败：${friendlyError(e)}`);
    } finally {
      setClearing(null);
    }
  };
  const handleSelectDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      onDirChange(selected);
    }
  };

  return (
    <div className="space-y-8">
      {/* 下载设置 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-gray-700">下载设置</h3>
          <p className="text-xs text-gray-400">配置视频下载的保存位置</p>
        </header>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">
            默认下载目录
          </label>
          <p className="text-xs text-gray-400 mb-2">
            不设置时，视频将下载到安装目录下的 <code className="bg-gray-100 px-1 rounded">downloads</code> 文件夹
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={dir}
              readOnly
              placeholder="未设置（使用安装目录/downloads/）"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-gray-50 text-gray-700 truncate"
            />
            <button
              onClick={handleSelectDir}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-sm"
            >
              <FolderOpen size={14} />
              选择
            </button>
            {dir && (
              <button
                onClick={() => onDirChange("")}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                重置
              </button>
            )}
          </div>
        </div>
      </section>

      {/* 历史记录管理 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-gray-700">历史记录</h3>
          <p className="text-xs text-gray-400">清除后不可恢复</p>
        </header>

        <div className="flex items-center gap-3">
          <button
            onClick={handleClearParse}
            disabled={clearing === "parse"}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={14} />
            {clearing === "parse" ? "清除中..." : "清除解析记录"}
          </button>
          <button
            onClick={handleClearDownload}
            disabled={clearing === "download"}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={14} />
            {clearing === "download" ? "清除中..." : "清除下载记录"}
          </button>
        </div>
      </section>

      <div className="pt-2 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors text-sm font-medium"
        >
          {saving ? "保存中..." : saved ? (
            <>
              <Check size={14} />
              已保存
            </>
          ) : "保存"}
        </button>
        {saved && (
          <span className="text-xs text-green-500">设置已保存</span>
        )}
      </div>
    </div>
  );
}
