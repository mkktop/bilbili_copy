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
    <div className="flex items-start gap-4 p-4 rounded-xl border border-gray-100 bg-white">
      <div className="p-2 rounded-lg bg-blue-50 text-blue-500 mt-0.5">
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-gray-800">{title}</h3>
        <p className="text-xs text-gray-400 mt-0.5">{description}</p>
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
    <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
            value === opt.value
              ? "bg-white text-blue-600 shadow-sm border border-gray-200"
              : "text-gray-500 hover:text-gray-700"
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
      <span className="text-sm text-gray-700">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
          checked ? "bg-blue-500" : "bg-gray-300"
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
        checked ? "bg-blue-500" : "bg-gray-300"
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
          "w-24 px-2.5 py-1.5 text-xs rounded-md border bg-white text-gray-700 transition-colors",
          unlimited
            ? "border-gray-200 text-gray-300 cursor-not-allowed bg-gray-50"
            : "border-gray-200 focus:border-blue-300 focus:ring-1 focus:ring-blue-300 outline-none"
        )}
      />
      {unit && <span className="text-xs text-gray-400">{unit}</span>}
      <button
        onClick={() => onChange(unlimited ? (min > 0 ? min : 1) : 0)}
        className={cn(
          "px-2 py-1 text-xs rounded-md border transition-colors",
          unlimited
            ? "bg-blue-50 border-blue-300 text-blue-600"
            : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
        )}
      >
        {unlimitedLabel}
      </button>
    </div>
  );
}
