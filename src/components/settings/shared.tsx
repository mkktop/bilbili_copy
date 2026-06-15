import { cn } from "../../lib/utils";

/// 设置卡片：带图标的标题 + 描述 + 内容区。各设置 Tab 共用。
export function SettingCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl border border-line bg-panel">
      <div className="p-2 rounded-lg bg-accent-soft text-accent mt-0.5">
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="text-xs text-ink-3 mt-0.5">{description}</p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

/// 分段控件，支持 number 与 string 值（用于数字档位与字幕格式 srt/vtt）。
export function SegmentedControl<T extends number | string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 bg-panel-2">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
            value === opt.value
              ? "bg-panel text-accent shadow-sm border border-line"
              : "text-ink-3 hover:text-ink-2"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/// 卡片内的小行 toggle（屏蔽顶部/底部等开关复用）。
export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink-2">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
          checked ? "bg-blue-500" : "bg-line-2"
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm",
            checked ? "translate-x-6" : "translate-x-1"
          )}
        />
      </button>
    </div>
  );
}

/// 卡片右侧的大开关（弹幕 / 字幕总开关复用）。
export function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
        checked ? "bg-blue-500" : "bg-line-2"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}

/// 数字输入控件：带单位后缀 + 「无限制」开关。
/// 无限制开关开启时 value=0 且输入框禁用；关闭时启用输入框。
export function NumberInput({
  value,
  onChange,
  unit,
  min = 0,
  step = 1,
  placeholder,
  unlimitedLabel = "无限制",
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  step?: number;
  placeholder?: string;
  unlimitedLabel?: string;
}) {
  const unlimited = value === 0;
  return (
    <div className="inline-flex items-center gap-2">
      <input
        type="number"
        value={unlimited ? "" : value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
        }}
        disabled={unlimited}
        min={min}
        step={step}
        placeholder={placeholder}
        className={cn(
          "w-24 px-2.5 py-1.5 text-xs rounded-md border bg-panel text-ink-2 transition-colors",
          unlimited
            ? "border-line text-ink-3 cursor-not-allowed bg-panel-2"
            : "border-line focus:border-accent focus:ring-1 focus:ring-accent outline-none"
        )}
      />
      {unit && <span className="text-xs text-ink-3">{unit}</span>}
      <button
        onClick={() => onChange(unlimited ? (min > 0 ? min : 1) : 0)}
        className={cn(
          "px-2 py-1 text-xs rounded-md border transition-colors",
          unlimited
            ? "bg-accent-soft border-accent text-accent"
            : "bg-panel border-line text-ink-3 hover:bg-panel-2"
        )}
      >
        {unlimitedLabel}
      </button>
    </div>
  );
}
