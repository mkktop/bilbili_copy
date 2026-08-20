import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Clock, X } from "lucide-react";
import type { VideoListItem, ParsedVideoInfo } from "../../types";
import { VideoCard } from "../VideoCard";
import { BatchBar } from "../BatchBar";
import { friendlyError } from "../../lib/errors";
import { useToast } from "../Toast";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载已选视频 */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
}

export function WatchLaterTab({ onParseVideo, onSelectItem, onBatchDownload }: Props) {
  const [items, setItems] = useState<VideoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);
  const [removingBvid, setRemovingBvid] = useState<string | null>(null);

  // 批量下载选择
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<VideoListItem[]>("get_watch_later");
      setItems(result);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSelect = async (item: VideoListItem) => {
    if (parsingBvid || !item.bvid) return;
    setParsingBvid(item.bvid);
    try {
      const videoInfo = await onParseVideo(
        `https://www.bilibili.com/video/${item.bvid}`
      );
      onSelectItem(videoInfo);
    } catch {
      // 解析失败已在上层处理
    } finally {
      setParsingBvid(null);
    }
  };

  const toggleSelect = (bvid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bvid)) next.delete(bvid);
      else next.add(bvid);
      return next;
    });
  };

  const downloadSelected = async () => {
    if (!onBatchDownload || selected.size === 0) return;
    setBatchBusy(true);
    try {
      await onBatchDownload([...selected]);
      setSelected(new Set());
      setSelectMode(false);
    } finally {
      setBatchBusy(false);
    }
  };

  // 从稍后再看移除（乐观更新 + 后端删除）
  const handleRemove = async (item: VideoListItem) => {
    if (!item.bvid || removingBvid) return;
    setRemovingBvid(item.bvid);
    setItems((prev) => prev.filter((i) => i.bvid !== item.bvid));
    setSelected((prev) => {
      if (!prev.has(item.bvid)) return prev;
      const next = new Set(prev);
      next.delete(item.bvid);
      return next;
    });
    try {
      await invoke("remove_watch_later", { bvid: item.bvid });
    } catch (e) {
      toast.error(`移除失败：${friendlyError(e)}`);
      load(); // 回滚乐观更新
    } finally {
      setRemovingBvid(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
        <AlertCircle size={20} />
        <p className="text-sm">{error}</p>
        <button onClick={load} className="text-xs text-blue-500 hover:underline">
          重试
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
        <Clock size={40} strokeWidth={1.5} />
        <p className="text-sm">稍后再看列表为空</p>
      </div>
    );
  }

  return (
    <div>
      {onBatchDownload && (
        <BatchBar
          selectMode={selectMode}
          onToggleMode={() => setSelectMode((v) => !v)}
          selectedCount={selected.size}
          totalCount={items.length}
          onSelectAll={() => setSelected(new Set(items.filter((i) => i.bvid).map((i) => i.bvid)))}
          onClearSelection={() => setSelected(new Set())}
          onDownloadSelected={downloadSelected}
          busy={batchBusy}
        />
      )}
      <div className="space-y-2">
        {items.map((item) => (
          <VideoCard
            key={item.bvid || item.title}
            title={item.title}
            cover={item.cover}
            upperName={item.upper_name}
            duration={item.duration}
            play={item.play}
            danmaku={item.danmaku}
            pubdate={item.pubdate}
            badge="稍后再看"
            loading={!selectMode && parsingBvid === item.bvid}
            disabled={!item.bvid}
            onClick={() => handleSelect(item)}
            selectMode={selectMode}
            selected={!!item.bvid && selected.has(item.bvid)}
            onToggleSelect={() => item.bvid && toggleSelect(item.bvid)}
            trailing={
              !selectMode && item.bvid ? (
                <button
                  onClick={() => handleRemove(item)}
                  disabled={removingBvid === item.bvid}
                  title="从稍后再看移除"
                  className="p-1.5 rounded-lg text-ink-3 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 mt-1 disabled:opacity-50"
                >
                  {removingBvid === item.bvid ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <X size={14} />
                  )}
                </button>
              ) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
