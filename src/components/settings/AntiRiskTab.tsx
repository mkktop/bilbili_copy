import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../Toast";
import { friendlyError } from "../../lib/errors";
import { Shield, Cpu, Timer, RefreshCw, Check } from "lucide-react";
import { cn } from "../../lib/utils";
import { SettingCard } from "./shared";

interface AntiRiskTabProps {
  gpuPreset: string;
  onGpuPresetChange: (v: string) => void;
  resolutionPreset: string;
  onResolutionPresetChange: (v: string) => void;
  dmImgStr: string;
  onDmImgStrChange: (v: string) => void;
  onDmCoverImgStrChange: (v: string) => void;
  onDmImgListChange: (v: string) => void;
  onDmImgInterChange: (v: string) => void;
  requestDelayMs: number;
  onRequestDelayMsChange: (v: number) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

interface PresetOption {
  id: string;
  name: string;
}

const DELAY_OPTIONS = [
  { value: 0, label: "关闭" },
  { value: 500, label: "500ms" },
  { value: 1000, label: "1s" },
  { value: 2000, label: "2s" },
  { value: 3000, label: "3s" },
];

export function AntiRiskTab({
  gpuPreset,
  onGpuPresetChange,
  resolutionPreset,
  onResolutionPresetChange,
  dmImgStr,
  onDmImgStrChange,
  onDmCoverImgStrChange,
  onDmImgListChange,
  onDmImgInterChange,
  requestDelayMs,
  onRequestDelayMsChange,
  saving,
  saved,
  onSave,
}: AntiRiskTabProps) {
  const [gpuOptions, setGpuOptions] = useState<PresetOption[]>([]);
  const [resOptions, setResOptions] = useState<PresetOption[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(!!dmImgStr);
  const toast = useToast();

  useEffect(() => {
    invoke<[string, string][]>("get_gpu_presets").then((opts) =>
      setGpuOptions(opts.map(([id, name]) => ({ id, name })))
    );
    invoke<[string, string][]>("get_resolution_presets").then((opts) =>
      setResOptions(opts.map(([id, name]) => ({ id, name })))
    );
  }, []);

  const handleGenerate = async () => {
    if (!gpuPreset || !resolutionPreset) return;
    setGenerating(true);
    try {
      const fp = await invoke<{
        dm_img_str: string;
        dm_cover_img_str: string;
        dm_img_list: string;
        dm_img_inter: string;
      }>("generate_fingerprint_cmd", { gpuPreset, resolutionPreset });
      onDmImgStrChange(fp.dm_img_str);
      onDmCoverImgStrChange(fp.dm_cover_img_str);
      onDmImgListChange(fp.dm_img_list);
      onDmImgInterChange(fp.dm_img_inter);
      setGenerated(true);
    } catch (e) {
      toast.error(`生成指纹失败：${friendlyError(e)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleRandomGenerate = async () => {
    setGenerating(true);
    try {
      const fp = await invoke<{
        dm_img_str: string;
        dm_cover_img_str: string;
        dm_img_list: string;
        dm_img_inter: string;
      }>("generate_random_fingerprint");
      onDmImgStrChange(fp.dm_img_str);
      onDmCoverImgStrChange(fp.dm_cover_img_str);
      onDmImgListChange(fp.dm_img_list);
      onDmImgInterChange(fp.dm_img_inter);
      onGpuPresetChange("");
      onResolutionPresetChange("");
      setGenerated(true);
    } catch (e) {
      toast.error(`生成指纹失败：${friendlyError(e)}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4 max-w-lg">
      <SettingCard
        icon={Cpu}
        title="设备指纹"
        description="模拟真实浏览器的 GPU 和 WebGL 指纹，降低被风控的概率。生成后需保存生效。"
      >
        <div className="space-y-3">
          <div className="flex gap-3">
            <select
              value={gpuPreset}
              onChange={(e) => onGpuPresetChange(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-line rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">选择 GPU 型号</option>
              {gpuOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <select
              value={resolutionPreset}
              onChange={(e) => onResolutionPresetChange(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-line rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">选择分辨率</option>
              {resOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={!gpuPreset || !resolutionPreset || generating}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
            >
              <Cpu size={14} />
              {generating ? "生成中..." : "生成指纹"}
            </button>
            <button
              onClick={handleRandomGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-line-2 rounded-lg hover:bg-panel-2 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={14} />
              随机生成
            </button>
            {generated && dmImgStr && (
              <span className="flex items-center gap-1 text-xs text-green-600 font-medium px-2">
                <Check size={14} /> 已生成
              </span>
            )}
          </div>
        </div>
      </SettingCard>

      <SettingCard
        icon={Timer}
        title="请求间隔"
        description="每次 playurl API 请求前的等待时间，避免短时间大量请求触发风控。"
      >
        <div className="inline-flex rounded-lg border border-line p-0.5 bg-panel-2">
          {DELAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onRequestDelayMsChange(opt.value)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                requestDelayMs === opt.value
                  ? "bg-panel text-accent shadow-sm border border-line"
                  : "text-ink-3 hover:text-ink-2"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingCard>

      <SettingCard
        icon={Shield}
        title="自动防护"
        description={
          <span className="text-ink-3">
            GeeTest 验证码自动弹出 · gaia_vtoken 自动缓存 1 小时 · Cookie 过期自动刷新
          </span>
        }
      >
        <span className="text-xs text-green-600 font-medium">
          ✓ 已默认开启，无需手动配置
        </span>
      </SettingCard>

      {/* Save button */}
      <button
        onClick={onSave}
        disabled={saving}
        className={cn(
          "w-full py-2.5 rounded-lg text-sm font-medium transition-colors",
          saved
            ? "bg-green-500 text-white"
            : "bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
        )}
      >
        {saving ? "保存中..." : saved ? "已保存 ✓" : "保存设置"}
      </button>
    </div>
  );
}
