import { useState, useMemo } from "react";
import { ArrowLeft, Download, Clock, CheckCircle2, Eye, MessageSquare, ArrowUpDown } from "lucide-react";
import type { ParsedItem, VideoPage } from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";

type EpisodeTab = "main" | "extra";

/** 格式化播放量：万 / 亿 */
function formatCount(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
  if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
  return n.toString();
}

interface VideoDetailProps {
  entry: ParsedItem;
  onBack: () => void;
  onDownload: (
    id: string,
    bvid: string,
    cid: number,
    title: string,
    videoTitle: string,
    epId?: number
  ) => void;
}

export function VideoDetail({ entry, onBack, onDownload }: VideoDetailProps) {
  const info = entry.videoInfo;
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [episodeTab, setEpisodeTab] = useState<EpisodeTab>("main");
  const [sortAsc, setSortAsc] = useState(true);

  if (!info) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <p className="text-sm">视频信息不可用</p>
        <button onClick={onBack} className="text-blue-500 text-sm hover:underline">
          返回
        </button>
      </div>
    );
  }

  const hasExtra = (info.extra_pages?.length ?? 0) > 0;
  const rawPages = episodeTab === "main" ? info.pages : (info.extra_pages ?? []);
  const currentPages = useMemo(
    () => sortAsc ? rawPages : [...rawPages].reverse(),
    [rawPages, sortAsc]
  );
  const isMultiPage = info.pages.length > 1 || hasExtra;
  const hasSelection = !isMultiPage || selectedPages.size > 0;

  const switchTab = (tab: EpisodeTab) => {
    if (tab !== episodeTab) {
      setEpisodeTab(tab);
      setSelectedPages(new Set());
    }
  };

  const togglePage = (page: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const selectAll = () => setSelectedPages(new Set(currentPages.map((p) => p.page)));
  const deselectAll = () => setSelectedPages(new Set());

  const handleDownload = () => {
    const folderName = info.series_title || info.title;
    const ids: string[] = [];
    if (!isMultiPage) {
      const p = info.pages[0];
      const pageBvid = p.bvid || info.bvid;
      const pageEpId = p.ep_id || info.ep_id;
      onDownload(entry.id, pageBvid, p.cid, info.title, folderName, pageEpId);
      ids.push(entry.id);
    } else {
      selectedPages.forEach((page) => {
        const p = currentPages.find((pg) => pg.page === page);
        if (p) {
          const pageBvid = p.bvid || info.bvid;
          const pageEpId = p.ep_id || info.ep_id;
          const title = `P${p.page} ${p.part}`;
          const id = `${entry.id}_P${p.page}`;
          onDownload(id, pageBvid, p.cid, title, folderName, pageEpId);
          ids.push(id);
        }
      });
    }
    setDownloadedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const isSingleDownloaded = !isMultiPage && downloadedIds.has(entry.id);
  const isAllDownloaded = isMultiPage && selectedPages.size > 0 && [...selectedPages].every((p) => downloadedIds.has(`${entry.id}_P${p}`));

  return (
    <div className="flex flex-col h-full">
      {/* 顶部栏 */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 bg-white">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">视频详情</h1>
        {downloadedIds.size > 0 && (
          <span className="text-xs text-green-500 font-medium flex items-center gap-1">
            <CheckCircle2 size={12} />
            已提交 {downloadedIds.size} 个下载
          </span>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* 封面区 — 模糊背景 + 完整封面 */}
        {info.pic && (
          <div className="w-full aspect-video max-h-56 relative overflow-hidden">
            <img
              src={info.pic}
              alt=""
              className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-60"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 to-black/50" />
            <img
              src={info.pic}
              alt={info.title}
              className="relative w-full h-full object-contain drop-shadow-lg"
            />
          </div>
        )}

        <div className="px-6 py-4 space-y-4">
          {/* 标题 */}
          <h2 className="text-base font-semibold text-gray-800 leading-snug">
            {info.title}
          </h2>

          {/* UP主卡片 */}
          {info.owner_face && (
            <div className="flex items-center gap-3 p-2.5 bg-gray-50 rounded-xl">
              <img
                src={info.owner_face}
                alt={info.owner_name}
                className="w-9 h-9 rounded-full object-cover ring-2 ring-white shadow-sm"
              />
              <span className="text-sm font-medium text-gray-700">{info.owner_name}</span>
            </div>
          )}

          {/* 统计数据 + 时长 */}
          <div className="flex items-center gap-4 text-xs text-gray-400">
            {(info.view_count ?? 0) > 0 && (
              <span className="flex items-center gap-1">
                <Eye size={13} />
                {formatCount(info.view_count!)}
              </span>
            )}
            {(info.danmaku_count ?? 0) > 0 && (
              <span className="flex items-center gap-1">
                <MessageSquare size={13} />
                {formatCount(info.danmaku_count!)}
              </span>
            )}
            {info.duration > 0 && (
              <span className="flex items-center gap-1">
                <Clock size={13} />
                {formatDuration(info.duration)}
              </span>
            )}
          </div>

          {/* 简介 */}
          {info.desc && (
            <p className="text-xs text-gray-400 leading-relaxed line-clamp-3 border-l-2 border-gray-200 pl-3">
              {info.desc}
            </p>
          )}

          {/* 正片/预告 切换（仅番剧显示） */}
          {hasExtra && (
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50">
              <button
                onClick={() => switchTab("main")}
                className={cn(
                  "px-4 py-1.5 text-xs font-medium rounded-md transition-all",
                  episodeTab === "main"
                    ? "bg-white text-blue-600 shadow-sm border border-gray-200"
                    : "text-gray-500 hover:text-gray-700"
                )}
              >
                正片（{info.pages.length}）
              </button>
              <button
                onClick={() => switchTab("extra")}
                className={cn(
                  "px-4 py-1.5 text-xs font-medium rounded-md transition-all",
                  episodeTab === "extra"
                    ? "bg-white text-blue-600 shadow-sm border border-gray-200"
                    : "text-gray-500 hover:text-gray-700"
                )}
              >
                预告/花絮（{info.extra_pages!.length}）
              </button>
            </div>
          )}

          {/* 分P列表 */}
          {isMultiPage && currentPages.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-600">
                  分P列表（已选 {selectedPages.size}/{currentPages.length}）
                </label>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => setSortAsc(v => !v)}
                    className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                    title={sortAsc ? "当前正序，点击倒序" : "当前倒序，点击正序"}
                  >
                    <ArrowUpDown size={12} />
                    {sortAsc ? "正序" : "倒序"}
                  </button>
                  <button
                    onClick={selectAll}
                    className="text-xs text-blue-500 hover:underline"
                  >
                    全选
                  </button>
                  <button
                    onClick={deselectAll}
                    className="text-xs text-gray-400 hover:underline"
                  >
                    取消全选
                  </button>
                </div>
              </div>
              <div className="space-y-1 flex-1 overflow-y-auto">
                {currentPages.map((p) => {
                  const pageId = `${entry.id}_P${p.page}`;
                  const isDownloaded = downloadedIds.has(pageId);
                  const isSelected = selectedPages.has(p.page);
                  return (
                    <div
                      key={`${episodeTab}-${p.page}`}
                      onClick={isDownloaded ? undefined : () => togglePage(p.page)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors",
                        isDownloaded
                          ? "bg-green-50 border border-green-200"
                          : isSelected
                            ? "bg-blue-50 border border-blue-200 cursor-pointer"
                            : "hover:bg-gray-50 border border-transparent cursor-pointer"
                      )}
                    >
                      {/* 序号标记 */}
                      <span className={cn(
                        "w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0",
                        isDownloaded
                          ? "bg-green-500 text-white"
                          : isSelected
                            ? "bg-blue-500 text-white"
                            : "bg-gray-100 text-gray-400"
                      )}>
                        {isDownloaded ? <CheckCircle2 size={12} /> : p.page}
                      </span>
                      <span className="text-sm text-gray-700 flex-1 truncate">
                        {p.part}
                      </span>
                      {p.duration > 0 && (
                        <span className="text-xs text-gray-400 shrink-0">
                          {formatDuration(p.duration)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 底部固定下载按钮 */}
      <div className="px-6 py-3 bg-white border-t border-gray-200">
        <button
          onClick={handleDownload}
          disabled={!hasSelection || isSingleDownloaded || isAllDownloaded}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors",
            hasSelection && !isSingleDownloaded && !isAllDownloaded
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "bg-gray-100 text-gray-400 cursor-not-allowed"
          )}
        >
          <Download size={16} />
          {isSingleDownloaded || isAllDownloaded
            ? "已提交下载"
            : isMultiPage
              ? `下载选中 (${selectedPages.size}P)`
              : "开始下载"}
        </button>
      </div>
    </div>
  );
}
