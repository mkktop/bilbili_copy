import { useState } from "react";
import { ArrowLeft, Download, Clock, ChevronRight } from "lucide-react";
import type { DownloadEntry } from "../types";
import { formatDuration } from "../types";
import { cn } from "../lib/utils";

const QUALITY_OPTIONS = [
  { value: 80, label: "1080P" },
  { value: 64, label: "720P" },
  { value: 32, label: "480P" },
  { value: 16, label: "360P" },
];

interface VideoDetailProps {
  entry: DownloadEntry;
  onBack: () => void;
  onDownload: (
    id: string,
    bvid: string,
    cid: number,
    title: string,
    qn: number
  ) => void;
}

export function VideoDetail({ entry, onBack, onDownload }: VideoDetailProps) {
  const info = entry.videoInfo;
  const [selectedQn, setSelectedQn] = useState(80);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

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

  const isMultiPage = info.pages.length > 1;
  const hasSelection = !isMultiPage || selectedPages.size > 0;

  const togglePage = (page: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const selectAll = () => setSelectedPages(new Set(info.pages.map((p) => p.page)));
  const deselectAll = () => setSelectedPages(new Set());

  const handleDownload = () => {
    if (isMultiPage) {
      selectedPages.forEach((page) => {
        const p = info.pages.find((pg) => pg.page === page);
        if (p) {
          const title =
            selectedPages.size > 1
              ? `${info.title} - P${p.page} ${p.part}`
              : info.title;
          onDownload(`${entry.id}_P${p.page}`, info.bvid, p.cid, title, selectedQn);
        }
      });
    } else {
      onDownload(entry.id, info.bvid, info.pages[0].cid, info.title, selectedQn);
    }
    onBack();
  };

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
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* 封面大图 */}
        {info.pic && (
          <div className="w-full aspect-video bg-gray-100 overflow-hidden">
            <img
              src={info.pic}
              alt={info.title}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className="px-6 py-4 space-y-4">
          {/* 标题 */}
          <h2 className="text-base font-semibold text-gray-800 leading-snug">
            {info.title}
          </h2>

          {/* UP主 + 时长 */}
          <div className="flex items-center gap-4 text-sm text-gray-500">
            {info.owner_face && (
              <span className="flex items-center gap-1.5">
                <img
                  src={info.owner_face}
                  alt={info.owner_name}
                  className="w-5 h-5 rounded-full object-cover"
                />
                {info.owner_name}
              </span>
            )}
            {info.duration > 0 && (
              <span className="flex items-center gap-1">
                <Clock size={14} />
                {formatDuration(info.duration)}
              </span>
            )}
          </div>

          {/* 简介 */}
          {info.desc && (
            <p className="text-sm text-gray-500 line-clamp-3">{info.desc}</p>
          )}

          {/* 画质选择 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">
              画质选择
            </label>
            <select
              value={selectedQn}
              onChange={(e) => setSelectedQn(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              {QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>

          {/* 分P列表 */}
          {isMultiPage && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-600">
                  分P列表（已选 {selectedPages.size}/{info.pages.length}）
                </label>
                <div className="flex gap-2">
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
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {info.pages.map((p) => (
                  <label
                    key={p.page}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors",
                      selectedPages.has(p.page)
                        ? "bg-blue-50 border border-blue-200"
                        : "hover:bg-gray-50 border border-transparent"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPages.has(p.page)}
                      onChange={() => togglePage(p.page)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-300"
                    />
                    <span className="text-sm text-gray-700 flex-1">
                      P{p.page} {p.part}
                    </span>
                    {p.duration > 0 && (
                      <span className="text-xs text-gray-400">
                        {formatDuration(p.duration)}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 下载按钮 */}
          <button
            onClick={handleDownload}
            disabled={!hasSelection}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors",
              hasSelection
                ? "bg-blue-500 text-white hover:bg-blue-600"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            )}
          >
            <Download size={16} />
            {isMultiPage
              ? `下载选中 (${selectedPages.size}P)`
              : "开始下载"}
          </button>
        </div>
      </div>
    </div>
  );
}
