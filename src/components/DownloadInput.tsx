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
    if (url && !isParsing) {
      onParse(url);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="download-input"
    >
      <Search size={18} className="shrink-0 text-ink-3" />
      <input
        name="url"
        type="text"
        aria-label="B 站视频或专栏链接"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴 B 站视频、合集或专栏链接"
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
        disabled={isParsing || !value.trim()}
      >
        {isParsing ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            正在解析
          </>
        ) : (
          <>
            <Search size={14} />
            解析链接
          </>
        )}
      </button>
    </form>
  );
}
