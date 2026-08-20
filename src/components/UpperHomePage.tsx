import { useRef } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { ParsedVideoInfo } from "../types";
import { UpperView } from "./tabs/UpperView";

interface Props {
  mid: number;
  /** 面包屑来源标签（如"视频详情"/"发现"），back 回到该来源 */
  sourceLabel: string;
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载（透传给 UpperView 的投稿/合集列表） */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
}

/**
 * UP 主主页全屏视图：头部返回栏 + 滚动容器 + 投稿/合集内容（UpperView）。
 * 从「发现」搜索结果、以及「视频详情页点头像」两处复用，避免重复内联布局。
 */
export function UpperHomePage({ mid, sourceLabel, onBack, onParseVideo, onSelectItem, onBatchDownload }: Props) {
  // VirtualList 需要外层滚动容器 ref 来做窗口化渲染
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      <header className="flex items-center gap-2 px-6 py-4 bg-panel border-b border-line">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors group"
          title={`返回${sourceLabel}`}
        >
          <ArrowLeft size={16} />
          <span className="text-sm text-ink-3 group-hover:text-ink-2 transition-colors max-w-[8em] truncate">
            {sourceLabel}
          </span>
        </button>
        <ChevronRight size={14} className="text-ink-3 shrink-0" />
        <h1 className="text-lg font-semibold text-ink">UP 主主页</h1>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
        <UpperView
          mid={mid}
          scrollRef={scrollRef}
          onParseVideo={onParseVideo}
          onSelectItem={onSelectItem}
          onBatchDownload={onBatchDownload}
        />
      </div>
    </div>
  );
}
