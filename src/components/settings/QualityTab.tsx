import { ChevronUp, ChevronDown } from "lucide-react";

// ==================== 常量 ====================

const VIDEO_QUALITY_OPTIONS = [
  { value: 127, label: "8K 超高清" },
  { value: 126, label: "杜比视界" },
  { value: 125, label: "HDR 真彩" },
  { value: 120, label: "4K 超清" },
  { value: 116, label: "1080P 60fps" },
  { value: 112, label: "1080P 高码率" },
  { value: 80, label: "1080P" },
  { value: 64, label: "720P" },
  { value: 32, label: "480P" },
  { value: 16, label: "360P" },
];

const AUDIO_QUALITY_OPTIONS = [
  { value: 30251, label: "Hi-Res 无损" },
  { value: 30250, label: "杜比全景声" },
  { value: 30280, label: "192K" },
  { value: 30232, label: "132K" },
  { value: 30216, label: "64K" },
];

const CODEC_OPTIONS = [
  { value: "AVC", label: "AVC (H.264)", desc: "兼容性最好" },
  { value: "HEV", label: "HEVC (H.265)", desc: "体积更小" },
  { value: "AV1", label: "AV1", desc: "开源免费" },
];

// ==================== Props ====================

interface QualityTabProps {
  videoMaxQuality: number;
  onVideoMaxQualityChange: (qn: number) => void;
  videoMinQuality: number;
  onVideoMinQualityChange: (qn: number) => void;
  audioMaxQuality: number;
  onAudioMaxQualityChange: (qn: number) => void;
  audioMinQuality: number;
  onAudioMinQualityChange: (qn: number) => void;
  codecPriority: string[];
  onCodecPriorityChange: (priority: string[]) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

export function QualityTab({
  videoMaxQuality,
  onVideoMaxQualityChange,
  videoMinQuality,
  onVideoMinQualityChange,
  audioMaxQuality,
  onAudioMaxQualityChange,
  audioMinQuality,
  onAudioMinQualityChange,
  codecPriority,
  onCodecPriorityChange,
  saving,
  saved,
  onSave,
}: QualityTabProps) {
  const moveCodec = (index: number, direction: "up" | "down") => {
    const next = [...codecPriority];
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onCodecPriorityChange(next);
  };

  return (
    <div className="space-y-8">
      {/* 视频质量 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">视频质量</h3>
          <p className="text-xs text-ink-3">设置视频流的画质范围</p>
        </header>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">
              最高画质
            </label>
            <select
              value={videoMaxQuality}
              onChange={(e) => onVideoMaxQualityChange(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {VIDEO_QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">
              最低画质
            </label>
            <select
              value={videoMinQuality}
              onChange={(e) => onVideoMinQualityChange(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value={0}>不限制</option>
              {VIDEO_QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-ink-3">
          当最高画质不可用时，会自动降级，但不低于最低画质
        </p>
      </section>

      {/* 音频质量 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">音频质量</h3>
          <p className="text-xs text-ink-3">设置音频流的质量范围</p>
        </header>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">
              最高音质
            </label>
            <select
              value={audioMaxQuality}
              onChange={(e) => onAudioMaxQualityChange(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {AUDIO_QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">
              最低音质
            </label>
            <select
              value={audioMinQuality}
              onChange={(e) => onAudioMinQualityChange(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value={0}>不限制</option>
              {AUDIO_QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* 编解码器优先级 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">编解码器优先级</h3>
          <p className="text-xs text-ink-3">同画质时优先选择排在前面的编解码器</p>
        </header>

        <div className="space-y-1">
          {codecPriority.map((codec, index) => {
            const info = CODEC_OPTIONS.find((c) => c.value === codec);
            return (
              <div
                key={codec}
                className="flex items-center gap-2 px-3 py-2 bg-panel border border-line rounded-lg"
              >
                <span className="text-xs font-mono text-ink-3 w-5">
                  {index + 1}
                </span>
                <div className="flex-1">
                  <span className="text-sm text-ink-2">{info?.label ?? codec}</span>
                  <span className="text-xs text-ink-3 ml-2">{info?.desc}</span>
                </div>
                <button
                  onClick={() => moveCodec(index, "up")}
                  disabled={index === 0}
                  className="p-1 rounded text-ink-3 hover:text-ink-2 hover:bg-panel-2 disabled:opacity-30 transition-colors"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  onClick={() => moveCodec(index, "down")}
                  disabled={index === codecPriority.length - 1}
                  className="p-1 rounded text-ink-3 hover:text-ink-2 hover:bg-panel-2 disabled:opacity-30 transition-colors"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* 保存按钮 */}
      <div className="pt-2 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors text-sm font-medium"
        >
          {saving ? "保存中..." : saved ? "✓ 已保存" : "保存"}
        </button>
        {saved && (
          <span className="text-xs text-green-500">设置已保存</span>
        )}
      </div>
    </div>
  );
}
