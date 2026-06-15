import { Search, Loader2 } from "lucide-react";

interface DownloadInputProps {
  onParse: (url: string) => void;
  isParsing: boolean;
}

export function DownloadInput({ onParse, isParsing }: DownloadInputProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("url") as HTMLInputElement;
    const url = input.value.trim();
    if (url) {
      onParse(url);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        name="url"
        type="text"
        placeholder="请输入B站视频链接..."
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
