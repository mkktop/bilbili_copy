import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Check } from "lucide-react";

interface GeneralTabProps {
  dir: string;
  ffmpegPath: string;
  onDirChange: (dir: string) => void;
  onFfmpegPathChange: (path: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

export function GeneralTab({
  dir,
  ffmpegPath,
  onDirChange,
  onFfmpegPathChange,
  saving,
  saved,
  onSave,
}: GeneralTabProps) {
  const handleSelectDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      onDirChange(selected);
    }
  };

  const handleSelectFfmpeg = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "ffmpeg", extensions: ["exe"] }],
    });
    if (selected && typeof selected === "string") {
      onFfmpegPathChange(selected);
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

        <div className="space-y-4">
          {/* 默认下载目录 */}
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
        </div>
      </section>

      {/* FFmpeg 设置 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-gray-700">FFmpeg 设置</h3>
          <p className="text-xs text-gray-400">用于合并B站分离的音视频流</p>
        </header>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">
            FFmpeg 路径
          </label>
          <p className="text-xs text-gray-400 mb-2">
            不设置时，将使用内置 FFmpeg 或系统 PATH 中的 <code className="bg-gray-100 px-1 rounded">ffmpeg</code>
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ffmpegPath}
              readOnly
              placeholder="未设置（使用内置 FFmpeg）"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-gray-50 text-gray-700 truncate"
            />
            <button
              onClick={handleSelectFfmpeg}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-sm"
            >
              <FolderOpen size={14} />
              选择
            </button>
            {ffmpegPath && (
              <button
                onClick={() => onFfmpegPathChange("")}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                重置
              </button>
            )}
          </div>
        </div>
      </section>

      {/* 保存按钮 */}
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
