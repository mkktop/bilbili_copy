import { useState, useCallback, useRef } from "react";
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
import { friendlyError } from "../lib/errors";
import { TID_OPTIONS } from "../lib/constants";

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

// 排序选项（仅 video 类型有效）
const ORDER_OPTIONS = [
  { value: "totalrank", label: "综合" },
  { value: "pubdate", label: "最新" },
  { value: "click", label: "播放量" },
  { value: "dm", label: "弹幕数" },
];

// 时长选项（仅 video 类型有效）
const DURATION_OPTIONS = [
  { value: "0", label: "全部" },
  { value: "1", label: "<10分" },
  { value: "2", label: "10-30分" },
  { value: "3", label: "30-60分" },
  { value: "4", label: ">60分" },
];

// 视频分区 tid 复用全局常量（与排行榜筛选共享）：见文件顶部 import TID_OPTIONS

export function ExplorePage({ onBack, onParseVideo, onSelectItem }: Props) {
  const [keyword, setKeyword] = useState("");
  const [searchType, setSearchType] = useState<SearchResultType>("video");
  // 视频搜索筛选器（仅 video 类型有效；其它类型时 state 保留但后端忽略）
  const [order, setOrder] = useState("totalrank");
  const [duration, setDuration] = useState("0");
  const [tids, setTids] = useState("0");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UP 主主页视图（UpperView）的虚拟化滚动容器 ref
  const upperScrollRef = useRef<HTMLDivElement>(null);
  const [upperMid, setUpperMid] = useState<number | null>(null);
  const [parsingKey, setParsingKey] = useState<string | null>(null);
  // 请求竞态控制：每次新搜索递增，响应回来时校验是否仍是最新请求，丢弃过期响应
  // 防止快速切换筛选器时旧响应覆盖新响应（结果错乱/累加）
  const searchReqId = useRef(0);

  const doSearch = useCallback(
    async (
      kw: string,
      type: SearchResultType,
      p: number,
      append: boolean,
      // 筛选参数显式传入，避免依赖闭包里的 state（state 更新是异步的，
      // onChange 后立即调 doSearch 会拿到旧值）
      fOrder: string,
      fDuration: string,
      fTids: string
    ) => {
      if (!kw.trim()) return;
      // 非追加（即新搜索/换筛选器/换页起点）时，标记为最新请求，丢弃之前的在途响应
      const reqId = append ? searchReqId.current : ++searchReqId.current;
      setSearching(true);
      setError(null);
      try {
        // 非 video 类型不传筛选参数（B站接口会忽略，这里显式回默认值更清晰）
        const isVideo = type === "video";
        const res = await invoke<SearchResultList>("search_videos", {
          keyword: kw,
          searchType: type,
          page: p,
          order: isVideo ? fOrder : "totalrank",
          duration: isVideo ? fDuration : "0",
          tids: isVideo ? fTids : "0",
        });
        // 竞态校验：若期间又发起了新搜索，丢弃本次过期响应
        if (reqId !== searchReqId.current) return;
        setResults((prev) => (append ? [...prev, ...res.results] : res.results));
        setTotal(res.total);
        setNumPages(res.num_pages);
        setPage(p);
        setSearched(true);
      } catch (e) {
        if (reqId !== searchReqId.current) return;
        setError(friendlyError(e));
        if (!append) setResults([]);
      } finally {
        // 仅当本次是最新请求时才关闭 loading（否则交给最新请求处理）
        if (reqId === searchReqId.current) setSearching(false);
      }
    },
    []
  );

  const handleSearch = () => doSearch(keyword, searchType, 1, false, order, duration, tids);

  const handleTypeChange = (type: SearchResultType) => {
    setSearchType(type);
    setResults([]);
    setSearched(false);
    if (keyword.trim()) doSearch(keyword, type, 1, false, order, duration, tids);
  };

  // 切换任一筛选器：用新值重置到第 1 页重新搜索（仅 video 类型有筛选器）
  // 注意：必须把新值作为参数传入，不能用 state（setX 是异步的，闭包里还是旧值）
  const handleOrderChange = (v: string) => {
    setOrder(v);
    if (keyword.trim()) doSearch(keyword, "video", 1, false, v, duration, tids);
  };
  const handleDurationChange = (v: string) => {
    setDuration(v);
    if (keyword.trim()) doSearch(keyword, "video", 1, false, order, v, tids);
  };
  const handleTidsChange = (v: string) => {
    setTids(v);
    if (keyword.trim()) doSearch(keyword, "video", 1, false, order, duration, v);
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
      <div className="flex flex-col h-screen bg-base text-ink">
        <header className="flex items-center gap-3 px-6 py-4 bg-panel border-b border-line">
          <button
            onClick={() => setUpperMid(null)}
            className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-lg font-semibold text-ink">UP 主主页</h1>
        </header>
        <div ref={upperScrollRef} className="flex-1 overflow-auto px-6 py-4">
          <UpperView
            mid={upperMid}
            scrollRef={upperScrollRef}
            onParseVideo={onParseVideo}
            onSelectItem={onSelectItem}
          />
        </div>
      </div>
    );
  }

  // ===== 搜索视图 =====
  return (
    <div className="flex flex-col h-screen bg-base text-ink">
      <header className="flex items-center gap-3 px-6 py-4 bg-panel border-b border-line">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-panel-2 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">发现</h1>
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
            className="flex-1 px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 placeholder:text-ink-3 focus:outline-none focus:border-accent"
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
                  ? "bg-accent-soft border-accent text-accent"
                  : "bg-panel border-line text-ink-3 hover:bg-panel-2"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* 高级筛选器：仅 video 类型显示（UP主/番剧/影视搜索不支持 order/duration/tids） */}
        {searchType === "video" && (
          <div className="space-y-2 mb-4">
            <FilterRow
              label="排序"
              options={ORDER_OPTIONS}
              value={order}
              onChange={handleOrderChange}
            />
            <FilterRow
              label="时长"
              options={DURATION_OPTIONS}
              value={duration}
              onChange={handleDurationChange}
            />
            <FilterRow
              label="分区"
              options={TID_OPTIONS}
              value={tids}
              onChange={handleTidsChange}
            />
          </div>
        )}

        {/* 错误 */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mb-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* 搜索结果 */}
        {searching && results.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-ink-3 gap-2">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">搜索中...</span>
          </div>
        ) : !searched ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
            <Search size={40} strokeWidth={1.5} />
            <p className="text-sm">输入关键词开始搜索</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
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
                  onClick={() => doSearch(keyword, searchType, page + 1, true, order, duration, tids)}
                  disabled={searching}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-panel-2 disabled:opacity-50 transition-colors"
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

/** 筛选器一行：左侧 label + 右侧分段按钮组（分区项多时自动换行） */
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-ink-3 mt-1.5 w-8 shrink-0">{label}</span>
      <div className="flex gap-1 flex-wrap">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              value === opt.value
                ? "bg-accent-soft border-accent text-accent"
                : "bg-panel border-line text-ink-3 hover:bg-panel-2"
            }`}
          >
            {opt.label}
          </button>
        ))}
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
    "flex items-start gap-3 w-full px-4 py-3 bg-panel border border-line rounded-lg hover:bg-panel-2 hover:border-line-2 transition-colors text-left disabled:opacity-70";

  if (result.type === "bili_user") {
    return (
      <button onClick={onClick} disabled={loading} className={baseBtn}>
        <img
          src={result.cover}
          alt={result.title}
          className="w-12 h-12 rounded-full object-cover bg-panel-2 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink-2 truncate">
            {result.title}
          </p>
          <div className="flex items-center gap-3 mt-1 text-xs text-ink-3">
            <span className="flex items-center gap-0.5">
              <Users size={10} />
              {formatCount(result.follower ?? 0)} 粉丝
            </span>
          </div>
          {result.description && (
            <p className="text-xs text-ink-3 mt-1 line-clamp-1">
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
          className="w-12 h-16 rounded object-cover bg-panel-2 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
            {result.title}
          </p>
          {result.author && (
            <p className="text-xs text-ink-3 mt-1 line-clamp-1">
              {result.author}
            </p>
          )}
          {result.description && (
            <p className="text-xs text-ink-3 mt-0.5 line-clamp-1">
              {result.description}
            </p>
          )}
          <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-panel-2 text-ink-3 text-[10px]">
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
        className="w-24 h-16 rounded object-cover bg-panel-2 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink-2 line-clamp-2 leading-snug">
          {result.title}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-3 flex-wrap">
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
