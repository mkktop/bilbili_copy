import { useState, useCallback, useRef, useEffect } from "react";
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
  History,
  Flame,
  X,
  Trash2,
} from "lucide-react";
import type {
  SearchResult,
  SearchResultList,
  SearchResultType,
  ParsedVideoInfo,
  HotSearchItem,
} from "../types";
import { UpperHomePage } from "./UpperHomePage";
import { formatCount } from "./VideoCard";
import { friendlyError } from "../lib/errors";
import { TID_OPTIONS } from "../lib/constants";

interface Props {
  onBack: () => void;
  onParseVideo: (url: string) => Promise<ParsedVideoInfo>;
  onSelectItem: (videoInfo: ParsedVideoInfo) => void;
  /** 批量下载（透传给内嵌的 UP 主主页 UpperView） */
  onBatchDownload?: (bvids: string[], folder?: string) => Promise<void>;
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

export function ExplorePage({ onBack, onParseVideo, onSelectItem, onBatchDownload }: Props) {
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

  // 搜索联想：输入 ≥2 字符时防抖 300ms 拉取，点击直接搜索
  const [suggests, setSuggests] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const [upperMid, setUpperMid] = useState<number | null>(null);
  const [parsingKey, setParsingKey] = useState<string | null>(null);
  // 搜索历史（本地 DB，最近 10 条）与热搜榜（公开 API）：未搜索时展示在结果区
  const [history, setHistory] = useState<string[]>([]);
  const [hotSearch, setHotSearch] = useState<HotSearchItem[]>([]);
  // 请求竞态控制：每次新搜索递增，响应回来时校验是否仍是最新请求，丢弃过期响应
  // 防止快速切换筛选器时旧响应覆盖新响应（结果错乱/累加）
  const searchReqId = useRef(0);

  // 首次挂载：并行加载搜索历史与热搜榜（失败静默，不影响搜索主流程）
  useEffect(() => {
    invoke<string[]>("get_search_history", { limit: 10 })
      .then(setHistory)
      .catch(() => {});
    invoke<HotSearchItem[]>("get_hot_search", { limit: 10 })
      .then(setHotSearch)
      .catch(() => {});
  }, []);

  // 落库搜索词 + 乐观更新本地历史（去重置顶，保留 10 条）
  const recordKeyword = useCallback((kw: string) => {
    const k = kw.trim();
    if (!k) return;
    invoke("save_search_keyword", { keyword: k }).catch(() => {});
    setHistory((prev) => [k, ...prev.filter((x) => x !== k)].slice(0, 10));
  }, []);

  // 联想词防抖：输入变化 300ms 后拉取（≥2 字符）；关闭下拉时清空
  useEffect(() => {
    const k = keyword.trim();
    if (k.length < 2) {
      setSuggests([]);
      setSuggestOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      invoke<string[]>("get_search_suggest", { term: k })
        .then((items) => {
          setSuggests(items);
          setSuggestOpen(items.length > 0);
        })
        .catch(() => setSuggests([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  // 点击联想词：填入并立即搜索（收起下拉）
  const pickSuggest = (kw: string) => {
    setSuggestOpen(false);
    searchKeyword(kw);
  };

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

  const handleSearch = () => {
    recordKeyword(keyword);
    doSearch(keyword, searchType, 1, false, order, duration, tids);
  };

  // 点击历史词/热搜词：填入输入框并立即搜索（词作为参数传入，setState 异步不能依赖）
  const searchKeyword = (kw: string) => {
    setKeyword(kw);
    recordKeyword(kw);
    doSearch(kw, searchType, 1, false, order, duration, tids);
  };

  // 删除单条历史词（乐观更新 + 落库）
  const removeHistoryItem = (kw: string) => {
    setHistory((prev) => prev.filter((x) => x !== kw));
    invoke("delete_search_keyword", { keyword: kw }).catch(() => {});
  };

  // 清空全部历史
  const clearHistory = () => {
    setHistory([]);
    invoke("clear_search_history").catch(() => {});
  };

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
      <UpperHomePage
        mid={upperMid}
        sourceLabel="发现"
        onBack={() => setUpperMid(null)}
        onParseVideo={onParseVideo}
        onSelectItem={onSelectItem}
        onBatchDownload={onBatchDownload}
      />
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
        {/* 搜索框（含联想下拉） */}
        <div className="relative flex gap-2 mb-3">
          <div className="relative flex-1">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onFocus={() => { if (suggests.length > 0) setSuggestOpen(true); }}
              onBlur={() => {
                // 延迟收起：给 mousedown 选中联想词留出时间（blur 先于 click）
                setTimeout(() => setSuggestOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setSuggestOpen(false);
                  handleSearch();
                }
              }}
              placeholder="搜索视频、UP主、番剧..."
              className="w-full px-3 py-2 text-sm border border-line-2 rounded-lg bg-panel text-ink-2 placeholder:text-ink-3 focus:outline-none focus:border-accent"
            />
            {/* 联想下拉 */}
            {suggestOpen && suggests.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg bg-panel border border-line shadow-xl py-1">
                {suggests.map((s) => (
                  <button
                    key={s}
                    // mousedown 触发（早于 input blur 收起下拉）
                    onMouseDown={(e) => { e.preventDefault(); pickSuggest(s); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-ink-2 hover:bg-panel-2 transition-colors"
                  >
                    <Search size={12} className="text-ink-3 shrink-0" />
                    <span className="truncate">{s}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
          /* 未搜索：展示搜索历史（本地）+ 热搜榜（B站）；两者都空时回退引导文案 */
          history.length === 0 && hotSearch.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-ink-3 gap-2">
              <Search size={40} strokeWidth={1.5} />
              <p className="text-sm">输入关键词开始搜索</p>
            </div>
          ) : (
            <div className="space-y-5 pt-1">
              {/* 搜索历史：chip 列表，悬停显示单条删除，右上角清空 */}
              {history.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <History size={13} />
                      搜索历史
                    </h3>
                    <button
                      onClick={clearHistory}
                      className="flex items-center gap-1 text-xs text-ink-3 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={12} />
                      清空
                    </button>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {history.map((kw) => (
                      <span
                        key={kw}
                        className="group inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 text-xs rounded-full bg-panel border border-line text-ink-2 hover:border-accent hover:text-accent transition-colors cursor-pointer"
                        onClick={() => searchKeyword(kw)}
                      >
                        <span className="max-w-[160px] truncate">{kw}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeHistoryItem(kw); }}
                          title="删除"
                          className="p-0.5 rounded-full text-ink-3 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* 热搜榜：带名次的双列列表，前 3 名红色高亮 */}
              {hotSearch.length > 0 && (
                <section>
                  <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-2 mb-2">
                    <Flame size={13} className="text-orange-500" />
                    B站热搜
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {hotSearch.map((h, idx) => (
                      <button
                        key={h.keyword}
                        onClick={() => searchKeyword(h.keyword)}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left hover:bg-panel-2 transition-colors"
                      >
                        <span
                          className={`w-5 text-center text-xs font-bold shrink-0 ${
                            idx < 3 ? "text-orange-500" : "text-ink-3"
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <span className="text-sm text-ink-2 truncate">{h.show_name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )
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
