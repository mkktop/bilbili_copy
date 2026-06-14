import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, Clock } from "lucide-react";
import type { VideoListItem, ParsedVideoInfo } from "../../types";
import { VideoCard } from "../VideoCard";
import { friendlyError } from "../../lib/errors";

interface Props {
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

export function WatchLaterTab({ onParseVideo, onSelectItem }: Props) {
  const [items, setItems] = useState<VideoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsingBvid, setParsingBvid] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
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
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
        <Clock size={40} strokeWidth={1.5} />
        <p className="text-sm">稍后再看列表为空</p>
      </div>
    );
  }

  return (
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
          loading={parsingBvid === item.bvid}
          disabled={!item.bvid}
          onClick={() => handleSelect(item)}
        />
      ))}
    </div>
  );
}
