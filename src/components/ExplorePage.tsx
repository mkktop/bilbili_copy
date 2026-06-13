import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Search,
  Loader2,
  AlertCircle,
  ArrowLeft,
  User,
  Film,
  Tv,
  Eye,
  MessageSquare,
  Clock,
  Users,
} from "lucide-react";
import type {
  SearchResult,
  SearchResultList,
  SearchResultType,
  ParsedVideoInfo,
} from "../types";
import { UpperView } from "./tabs/UpperView";
import { formatCount } from "./VideoCard";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
}

const TYPE_TABS: { key: SearchResultType; label: string; Icon: typeof Film }[] = [
  { key: "video", label: "视频", Icon: Film },
  { key: "bili_user", label: "UP主", Icon: User },
  { key: "media_bangumi", label: "番剧", Icon: Tv },
  { key: "media_ft", label: "影视", Icon: Tv },
];

export function ExplorePage({ onBack, onParseVideo, onSelectItem }: Props) {
  const [keyword, setKeyword] = useState("");
  const [searchType, setSearchType] = useState<SearchResultType>("video");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upperMid, setUpperMid] = useState<number | null>(null);
  const [parsingKey, setParsingKey] = useState<string | null>(null);

  const doSearch = useCallback(
    async (
      kw: string,
      type: SearchResultType,
      p: number,
      append: boolean
    ) => {
      if (!kw.trim()) return;
      setSearching(true);
      setError(null);
      try {
        const res = await invoke<SearchResultList>("search_videos", {
          keyword: kw,
          searchType: type,
          page: p,
        });
        setResults((prev) => (append ? [...prev, ...res.results] : res.results));
        setTotal(res.total);
        setNumPages(res.num_pages);
        setPage(p);
        setSearched(true);
      } catch (e) {
        setError(String(e));
        if (!append) setResults([]);
      } finally {
        setSearching(false);
      }
    },
    []
  );

  const handleSearch = () => doSearch(keyword, searchType, 1, false);

  const handleTypeChange = (type: SearchResultType) => {
    setSearchType(type);
    setResults([]);
    setSearched(false);
    if (keyword.trim()) doSearch(keyword, type, 1, false);
  };

  const handleSelectResult = async (r: SearchResult) => {
    if (parsingKey) return;
    // UP 主 → 进入 UP 主主页
    if (r.type === "bili_user" && r.mid) {
      setUpperMid(r.mid);
      return;
    }
    let url = "";
    if (r.type === "video" && r.bvid) {
      url = `https://www.bilibili.com/video/${r.bvid}`;
    } else if (
      (r.type === "media_bangumi" || r.type === "media_ft") &&
      r.season_id
    ) {
      url = `https://www.bilibili.com/bangumi/play/ss${r.season_id}`;
    }
    if (!url) return;
    const key = r.bvid || r.season_id || String(r.mid);
    setParsingKey(key);
    try {
      const info = await onParseVideo(url);
      onSelectItem(info);
    } catch {
      // 上层处理
    } finally {
      setParsingKey(null);
    }
  };

  // ===== UP 主主页视图 =====
  if (upperMid !== null) {
    return (
      <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
        <header className="flex items-center gap-3 px-6 py-4 bg-white border-b border-gray-200">
          <button
            onClick={() => setUpperMid(null)}
            className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-lg font-semibold text-gray-800">UP 主主页</h1>
        </header>
        <div className="flex-1 overflow-auto px-6 py-4">
          <UpperView
            mid={upperMid}
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
          />
        </div>
      </div>
    );
  }

  // ===== 搜索视图 =====
  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center gap-3 px-6 py-4 bg-white border-b border-gray-200">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">发现</h1>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 搜索框 */}
        <div className="flex gap-2 mb-3">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            placeholder="搜索视频、UP主、番剧..."
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !keyword.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            {searching ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            搜索
          </button>
        </div>

        {/* 类型 tab */}
        <div className="flex gap-1 mb-4 flex-wrap">
          {TYPE_TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => handleTypeChange(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                searchType === key
                  ? "bg-blue-50 border-blue-300 text-blue-600"
                  : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mb-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* 搜索结果 */}
        {searching && results.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">搜索中...</span>
          </div>
        ) : !searched ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <Search size={40} strokeWidth={1.5} />
            <p className="text-sm">输入关键词开始搜索</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
            <Search size={40} strokeWidth={1.5} />
            <p className="text-sm">没有找到相关结果</p>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((r) => {
              const key = r.bvid || r.season_id || `u-${r.mid}` || r.title;
              const loading = parsingKey === key;
              return (
                <ResultCard
                  key={key}
                  result={r}
                  loading={loading}
                  onClick={() => handleSelectResult(r)}
                />
              );
            })}

            {/* 加载更多 */}
            {page < numPages && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={() => doSearch(keyword, searchType, page + 1, true)}
                  disabled={searching}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  {searching ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      加载中...
                    </>
                  ) : (
                    "加载更多"
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 单条搜索结果卡片（按类型渲染） */
function ResultCard({
  result,
  loading,
  onClick,
}: {
  result: SearchResult;
  loading: boolean;
  onClick: () => void;
}) {
  const baseBtn =
    "flex items-start gap-3 w-full px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left disabled:opacity-70";

  if (result.type === "bili_user") {
    return (
      <button onClick={onClick} disabled={loading} className={baseBtn}>
        <img
          src={result.cover}
          alt={result.title}
          className="w-12 h-12 rounded-full object-cover bg-gray-100 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-700 truncate">
            {result.title}
          </p>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
            <span className="flex items-center gap-0.5">
              <Users size={10} />
              {formatCount(result.follower ?? 0)} 粉丝
            </span>
          </div>
          {result.description && (
            <p className="text-xs text-gray-400 mt-1 line-clamp-1">
              {result.description}
            </p>
          )}
        </div>
        {loading && (
          <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
        )}
      </button>
    );
  }

  if (result.type === "media_bangumi" || result.type === "media_ft") {
    return (
      <button onClick={onClick} disabled={loading} className={baseBtn}>
        <img
          src={result.cover}
          alt={result.title}
          className="w-12 h-16 rounded object-cover bg-gray-100 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
            {result.title}
          </p>
          {result.author && (
            <p className="text-xs text-gray-400 mt-1 line-clamp-1">
              {result.author}
            </p>
          )}
          {result.description && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
              {result.description}
            </p>
          )}
          <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 text-[10px]">
            {result.type === "media_bangumi" ? "番剧" : "影视"}
          </span>
        </div>
        {loading && (
          <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
        )}
      </button>
    );
  }

  // video
  return (
    <button onClick={onClick} disabled={loading} className={baseBtn}>
      <img
        src={result.cover}
        alt={result.title}
        className="w-24 h-16 rounded object-cover bg-gray-100 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
          {result.title}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400 flex-wrap">
          <span className="flex items-center gap-0.5">
            <User size={10} />
            {result.author}
          </span>
          {result.duration && (
            <span className="flex items-center gap-0.5">
              <Clock size={10} />
              {result.duration}
            </span>
          )}
          {!!result.play && result.play > 0 && (
            <span className="flex items-center gap-0.5">
              <Eye size={10} />
              {formatCount(result.play)}
            </span>
          )}
          {!!result.danmaku && result.danmaku > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {formatCount(result.danmaku)}
            </span>
          )}
        </div>
      </div>
      {loading && (
        <Loader2 size={16} className="animate-spin text-blue-500 shrink-0 mt-1" />
      )}
    </button>
  );
}
