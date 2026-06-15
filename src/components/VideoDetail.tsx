import { useState, useMemo } from "react";
import { ArrowLeft, Download, Clock, CheckCircle2, Eye, MessageSquare, ArrowUpDown } from "lucide-react";
import type { ParsedItem, VideoPage, VideoMeta } from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";
import { formatCount } from "./VideoCard";
import { CommentSection } from "./CommentSection";
import { InteractionBar } from "./InteractionBar";

type EpisodeTab = "main" | "extra";

interface VideoDetailProps {
  entry: ParsedItem;
  onBack: () => void;
  onDownload: (
    id: string,
    bvid: string,
    cid: number,
    title: string,
    videoTitle: string,
    epId?: number,
    duration?: number,
    pic?: string,
    subtitleOnly?: boolean,
    audioOnly?: boolean,
    videoMeta?: VideoMeta
  ) => void;
}

export function VideoDetail({ entry, onBack, onDownload }: VideoDetailProps) {
  const info = entry.videoInfo;
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [episodeTab, setEpisodeTab] = useState<EpisodeTab>("main");
  const [sortAsc, setSortAsc] = useState(true);
  const [subtitleOnly, setSubtitleOnly] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);

  if (!info) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-3 gap-2">
        <p className="text-sm">视频信息不可用</p>
        <button onClick={onBack} className="text-accent text-sm hover:underline">
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
    // 从已解析的 videoInfo 构造 NFO 元数据快照（透传给后端生成 .nfo + 封面图）。
    // 分P场景下 title 按具体分P覆盖，其它字段（简介/UP主/封面/统计）合集共用。
    const buildMeta = (nfoTitle: string, duration: number): VideoMeta => ({
      bvid: info.bvid,
      title: nfoTitle,
      desc: info.desc,
      pic: info.pic,
      owner_mid: info.owner_mid,
      owner_name: info.owner_name,
      owner_face: info.owner_face,
      duration,
      pubdate: info.pubdate ?? 0,
      view_count: info.view_count ?? 0,
      like_count: info.like_count ?? 0,
      danmaku_count: info.danmaku_count ?? 0,
      tags: info.tags ?? [],
    });

    const ids: string[] = [];
    if (!isMultiPage) {
      const p = info.pages[0];
      const pageBvid = p.bvid || info.bvid;
      const pageEpId = p.ep_id || info.ep_id;
      onDownload(entry.id, pageBvid, p.cid, info.title, folderName, pageEpId, p.duration, info.pic, subtitleOnly, audioOnly, buildMeta(info.title, p.duration));
      ids.push(entry.id);
    } else {
      selectedPages.forEach((page) => {
        const p = currentPages.find((pg) => pg.page === page);
        if (p) {
          const pageBvid = p.bvid || info.bvid;
          const pageEpId = p.ep_id || info.ep_id;
          const title = `P${p.page} ${p.part}`;
          const id = `${entry.id}_P${p.page}`;
          onDownload(id, pageBvid, p.cid, title, folderName, pageEpId, p.duration, info.pic, subtitleOnly, audioOnly, buildMeta(title, p.duration));
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
      <div className="flex items-center gap-3 px-6 py-4 border-b border-line bg-panel">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">视频详情</h1>
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
          <h2 className="text-base font-semibold text-ink leading-snug">
            {info.title}
          </h2>

          {/* UP主卡片 */}
          {info.owner_face && (
            <div className="flex items-center gap-3 p-2.5 bg-panel-2 rounded-xl">
              <img
                src={info.owner_face}
                alt={info.owner_name}
                className="w-9 h-9 rounded-full object-cover ring-2 ring-panel shadow-sm"
              />
              <span className="text-sm font-medium text-ink-2">{info.owner_name}</span>
            </div>
          )}

          {/* 统计数据 + 时长 */}
          <div className="flex items-center gap-4 text-xs text-ink-3">
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

          {/* 互动操作栏：点赞 / 投币 / 收藏（需登录） */}
          <InteractionBar
            bvid={info.bvid}
            aid={info.aid}
            likeCount={info.like_count}
          />

          {/* 简介 */}
          {info.desc && (
            <p className="text-xs text-ink-3 leading-relaxed line-clamp-3 border-l-2 border-line pl-3">
              {info.desc}
            </p>
          )}

          {/* 正片/预告 切换（仅番剧显示） */}
          {hasExtra && (
            <div className="inline-flex rounded-lg border border-line p-0.5 bg-panel-2">
              <button
                onClick={() => switchTab("main")}
                className={cn(
                  "px-4 py-1.5 text-xs font-medium rounded-md transition-all",
                  episodeTab === "main"
                    ? "bg-panel text-accent shadow-sm border border-line"
                    : "text-ink-3 hover:text-ink-2"
                )}
              >
                正片（{info.pages.length}）
              </button>
              <button
                onClick={() => switchTab("extra")}
                className={cn(
                  "px-4 py-1.5 text-xs font-medium rounded-md transition-all",
                  episodeTab === "extra"
                    ? "bg-panel text-accent shadow-sm border border-line"
                    : "text-ink-3 hover:text-ink-2"
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
                <label className="text-xs font-medium text-ink-2">
                  分P列表（已选 {selectedPages.size}/{currentPages.length}）
                </label>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => setSortAsc(v => !v)}
                    className="text-xs text-ink-3 hover:text-ink-2 flex items-center gap-0.5"
                    title={sortAsc ? "当前正序，点击倒序" : "当前倒序，点击正序"}
                  >
                    <ArrowUpDown size={12} />
                    {sortAsc ? "正序" : "倒序"}
                  </button>
                  <button
                    onClick={selectAll}
                    className="text-xs text-accent hover:underline"
                  >
                    全选
                  </button>
                  <button
                    onClick={deselectAll}
                    className="text-xs text-ink-3 hover:underline"
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
                            : "hover:bg-panel-2 border border-transparent cursor-pointer"
                      )}
                    >
                      {/* 序号标记 */}
                      <span className={cn(
                        "w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0",
                        isDownloaded
                          ? "bg-green-500 text-white"
                          : isSelected
                            ? "bg-blue-500 text-white"
                            : "bg-panel-2 text-ink-3"
                      )}>
                        {isDownloaded ? <CheckCircle2 size={12} /> : p.page}
                      </span>
                      <span className="text-sm text-ink-2 flex-1 truncate">
                        {p.part}
                      </span>
                      {p.duration > 0 && (
                        <span className="text-xs text-ink-3 shrink-0">
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

        {/* 评论区：详情页底部，与上方内容同滚动 */}
        <CommentSection aid={info.aid} />
      </div>

      {/* 底部固定下载按钮 */}
      <div className="px-6 py-3 bg-panel border-t border-line space-y-2">
        {/* 模式选择：仅字幕 / 仅音频（互斥） */}
        <div className="flex items-center gap-4 py-1">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={subtitleOnly}
              onChange={(e) => { setSubtitleOnly(e.target.checked); if (e.target.checked) setAudioOnly(false); }}
              className="h-4 w-4 rounded border-line-2 text-blue-500 focus:ring-accent cursor-pointer"
            />
            <span className="text-xs text-ink-2">仅下载字幕</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={audioOnly}
              onChange={(e) => { setAudioOnly(e.target.checked); if (e.target.checked) setSubtitleOnly(false); }}
              className="h-4 w-4 rounded border-line-2 text-blue-500 focus:ring-accent cursor-pointer"
            />
            <span className="text-xs text-ink-2">仅下载音频</span>
          </label>
        </div>
        <button
          onClick={handleDownload}
          disabled={!hasSelection || isSingleDownloaded || isAllDownloaded}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors",
            hasSelection && !isSingleDownloaded && !isAllDownloaded
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "bg-panel-2 text-ink-3 cursor-not-allowed"
          )}
        >
          <Download size={16} />
          {isSingleDownloaded || isAllDownloaded
            ? "已提交下载"
            : subtitleOnly
              ? isMultiPage
                ? `仅下载字幕 (${selectedPages.size}P)`
                : "仅下载字幕"
              : audioOnly
                ? isMultiPage
                  ? `仅下载音频 (${selectedPages.size}P)`
                  : "仅下载音频"
                : isMultiPage
                  ? `下载选中 (${selectedPages.size}P)`
                  : "开始下载"}
        </button>
      </div>
    </div>
  );
}
