import { Search, Loader2, X } from "lucide-react";

interface DownloadInputProps {
  /** 受控输入值（App 持有，剪贴板/拖放识别到的链接从这里填入） */
  value: string;
  onChange: (v: string) => void;
  onParse: (url: string) => void;
  isParsing: boolean;
}

/** 首页居中的品牌化解析栏：大圆角、聚焦泛蓝光，支持一键清空 */
export function DownloadInput({ value, onChange, onParse, isParsing }: DownloadInputProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = value.trim();
    if (url) {
      onParse(url);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-3 rounded-2xl border border-line bg-panel/60 px-5 shadow-lg shadow-blue-500/5 backdrop-blur-md transition-all focus-within:border-blue-400/50 focus-within:ring-2 focus-within:ring-blue-400/40 focus-within:shadow-blue-500/10"
    >
      <Search size={18} className="shrink-0 text-ink-3" />
      <input
        name="url"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴 B 站链接，未雨为你绸缪…"
        disabled={isParsing}
        className="flex-1 bg-transparent py-3.5 text-sm text-ink-2 placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
      />
      {value && !isParsing && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="清空"
          className="p-1 rounded-full text-ink-3 hover:text-ink-2 hover:bg-panel-2 transition-colors"
        >
          <X size={14} />
        </button>
      )}
      <button
        type="submit"
        disabled={isParsing}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/25 bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-400 px-6 py-2 text-sm font-bold text-white shadow-md shadow-blue-400/30 transition-all hover:scale-105 hover:shadow-lg hover:shadow-blue-400/40 active:scale-95 disabled:opacity-50"
      >
        {isParsing ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            未雨中...
          </>
        ) : (
          <>
            <Search size={14} />
            未雨一下
          </>
        )}
      </button>
    </form>
  );
}
