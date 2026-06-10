import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Check } from "lucide-react";

const QUALITY_OPTIONS = [
  { value: 127, label: "8K 超高清" },
  { value: 120, label: "4K 超清" },
  { value: 116, label: "1080P 60fps" },
  { value: 112, label: "1080P 高码率" },
  { value: 80, label: "1080P" },
  { value: 64, label: "720P" },
  { value: 32, label: "480P" },
  { value: 16, label: "360P" },
];

interface GeneralTabProps {
  dir: string;
  onDirChange: (dir: string) => void;
  maxQuality: number;
  onMaxQualityChange: (qn: number) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

export function GeneralTab({
  dir,
  onDirChange,
  maxQuality,
  onMaxQualityChange,
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

      {/* 画质设置 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-gray-700">画质设置</h3>
          <p className="text-xs text-gray-400">设置视频下载的最大画质，不满足时自动降级</p>
        </header>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">
            默认最大画质
          </label>
          <select
            value={maxQuality}
            onChange={(e) => onMaxQualityChange(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            {QUALITY_OPTIONS.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1.5">
            实际画质取决于视频源和账号权限，不支持时会自动选择下一可用画质
          </p>
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
