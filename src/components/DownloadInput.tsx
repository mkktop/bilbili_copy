import { Search, Loader2 } from "lucide-react";

interface DownloadInputProps {
  /** 受控输入值（App 持有，剪贴板/拖放识别到的链接从这里填入） */
  value: string;
  onChange: (v: string) => void;
  onParse: (url: string) => void;
  isParsing: boolean;
}

export function DownloadInput({ value, onChange, onParse, isParsing }: DownloadInputProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = value.trim();
    if (url) {
      onParse(url);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        name="url"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="请输入B站视频链接（复制后切回窗口自动填入）..."
        disabled={isParsing}
        className="flex-1 px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={isParsing}
        className="flex items-center gap-1.5 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap"
      >
        {isParsing ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            解析中...
          </>
        ) : (
          <>
            <Search size={14} />
            解析
          </>
        )}
      </button>
    </form>
  );
}
