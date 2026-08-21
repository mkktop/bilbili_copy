import { MessageSquare, FileText, Sliders, Ban, History } from "lucide-react";
import { SettingCard, SegmentedControl, ToggleRow, ToggleSwitch } from "./shared";

interface SubtitleTabProps {
  // 弹幕总开关
  downloadDanmaku: boolean;
  onDownloadDanmakuChange: (v: boolean) => void;
  // 弹幕渲染
  dmFontSize: number;
  onDmFontSizeChange: (v: number) => void;
  dmScrollDuration: number;
  onDmScrollDurationChange: (v: number) => void;
  dmOpacity: number;
  onDmOpacityChange: (v: number) => void;
  // 屏蔽区域
  dmBlockTop: boolean;
  onDmBlockTopChange: (v: boolean) => void;
  dmBlockBottom: boolean;
  onDmBlockBottomChange: (v: boolean) => void;
  // 历史弹幕
  dmHistoryDays: number;
  onDmHistoryDaysChange: (v: number) => void;
  // 字幕总开关
  downloadSubtitle: boolean;
  onDownloadSubtitleChange: (v: boolean) => void;
  // 字幕格式
  subtitleFormat: string;
  onSubtitleFormatChange: (v: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

// 弹幕渲染档位预设（值就是后端存的原始数值）
const FONT_SIZE_OPTIONS = [
  { value: 18, label: "小" },
  { value: 25, label: "中" },
  { value: 36, label: "大" },
];
// 滚动时长（秒）：越大越慢，所以 label 反过来——"快"对应小值
const SCROLL_OPTIONS = [
  { value: 8, label: "快" },
  { value: 15, label: "标准" },
  { value: 25, label: "慢" },
];
// 弹幕「透明度」：值是 opacity（越高越不透明/越实）。标签用直观词，避免「低/高」在「透明度」语境下的歧义
// （旧版 低=0.2、高=0.8 与「透明度」直觉相反——选「高」反而最不透明）。现为：透明→0.2、不透明→0.8。
const OPACITY_OPTIONS = [
  { value: 0.8, label: "不透明" },
  { value: 0.5, label: "半透明" },
  { value: 0.2, label: "透明" },
];
const SUBTITLE_FORMAT_OPTIONS = [
  { value: "srt", label: "SRT" },
  { value: "vtt", label: "VTT" },
];
// 历史弹幕天数（0 = 关闭）。当前分段接口只返回最近一批，想看/保存更早的弹幕需按日合并。
const HISTORY_DAYS_OPTIONS = [
  { value: 0, label: "关闭" },
  { value: 3, label: "3 天" },
  { value: 7, label: "7 天" },
  { value: 14, label: "14 天" },
  { value: 30, label: "30 天" },
];

export function SubtitleTab({
  downloadDanmaku,
  onDownloadDanmakuChange,
  dmFontSize,
  onDmFontSizeChange,
  dmScrollDuration,
  onDmScrollDurationChange,
  dmOpacity,
  onDmOpacityChange,
  dmBlockTop,
  onDmBlockTopChange,
  dmBlockBottom,
  onDmBlockBottomChange,
  dmHistoryDays,
  onDmHistoryDaysChange,
  downloadSubtitle,
  onDownloadSubtitleChange,
  subtitleFormat,
  onSubtitleFormatChange,
  saving,
  saved,
  onSave,
}: SubtitleTabProps) {
  return (
    <div className="space-y-4 max-w-lg">
      {/* 弹幕区块标题 */}
      <div className="pt-1">
        <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">弹幕</h3>
      </div>

      <SettingCard
        icon={MessageSquare}
        title="下载弹幕"
        description="视频下载完成后自动保存弹幕为 ASS 字幕文件，可直接在播放器中加载显示。"
      >
        <ToggleSwitch checked={downloadDanmaku} onChange={onDownloadDanmakuChange} />
      </SettingCard>

      {/* 弹幕渲染配置：仅在开启弹幕下载时显示，避免无关配置干扰 */}
      {downloadDanmaku && (
        <SettingCard
          icon={Sliders}
          title="弹幕渲染"
          description="调整生成 ASS 文件的字号、滚动速度、透明度（仅影响新下载的弹幕文件）。"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2">字号</span>
              <SegmentedControl
                options={FONT_SIZE_OPTIONS}
                value={FONT_SIZE_OPTIONS.find((o) => o.value === dmFontSize)?.value ?? 25}
                onChange={onDmFontSizeChange}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2">滚动速度</span>
              <SegmentedControl
                options={SCROLL_OPTIONS}
                value={SCROLL_OPTIONS.find((o) => o.value === dmScrollDuration)?.value ?? 15}
                onChange={onDmScrollDurationChange}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2">透明度</span>
              <SegmentedControl
                options={OPACITY_OPTIONS}
                value={OPACITY_OPTIONS.reduce((best, o) =>
                  Math.abs(o.value - dmOpacity) < Math.abs(best.value - dmOpacity) ? o : best
                ).value}
                onChange={onDmOpacityChange}
              />
            </div>
          </div>
        </SettingCard>
      )}

      {/* 屏蔽顶部/底部弹幕：仅在开启弹幕下载时显示 */}
      {downloadDanmaku && (
        <SettingCard
          icon={Ban}
          title="屏蔽区域"
          description="勾选后对应类型的弹幕将不会写入 ASS 文件。"
        >
          <div className="divide-y divide-line">
            <ToggleRow
              label="屏蔽顶部弹幕"
              checked={dmBlockTop}
              onChange={onDmBlockTopChange}
            />
            <ToggleRow
              label="屏蔽底部弹幕"
              checked={dmBlockBottom}
              onChange={onDmBlockBottomChange}
            />
          </div>
        </SettingCard>
      )}

      {/* 历史弹幕：不依赖弹幕下载开关（播放器在线弹幕同样生效） */}
      <SettingCard
        icon={History}
        title="历史弹幕"
        description="合并最近 N 天的历史弹幕（按北京时间自然日）。下载 ASS 与播放器在线弹幕同时生效；天数越多请求数越多，热门视频弹幕量也会显著增大。"
      >
        <SegmentedControl
          options={HISTORY_DAYS_OPTIONS}
          value={HISTORY_DAYS_OPTIONS.find((o) => o.value === dmHistoryDays)?.value ?? 0}
          onChange={onDmHistoryDaysChange}
        />
      </SettingCard>

      {/* 字幕区块标题 */}
      <div className="pt-3">
        <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">字幕</h3>
      </div>

      <SettingCard
        icon={FileText}
        title="下载字幕"
        description="自动保存 CC 字幕文件（按语言分别保存，如 zh-Hans、en）。可在下方选择导出格式。"
      >
        <ToggleSwitch checked={downloadSubtitle} onChange={onDownloadSubtitleChange} />
      </SettingCard>

      {/* 字幕格式：仅在开启字幕下载时显示 */}
      {downloadSubtitle && (
        <SettingCard
          icon={FileText}
          title="字幕格式"
          description="SRT 兼容性最广；VTT (WebVTT) 适合网页播放器与部分现代播放器。"
        >
          <SegmentedControl
            options={SUBTITLE_FORMAT_OPTIONS}
            value={subtitleFormat === "vtt" ? "vtt" : "srt"}
            onChange={onSubtitleFormatChange}
          />
        </SettingCard>
      )}

      {/* Save button */}
      <button
        onClick={onSave}
        disabled={saving}
        className={
          "w-full py-2.5 rounded-lg text-sm font-medium transition-colors " +
          (saved
            ? "bg-green-500 text-white"
            : "bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50")
        }
      >
        {saving ? "保存中..." : saved ? "已保存 ✓" : "保存设置"}
      </button>
    </div>
  );
}
