import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Clock3, Download, FolderCheck, History, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { DownloadInput } from "../DownloadInput";
import type { ParsedItem, ParseHistoryEntry } from "../../types";
import { dbToParsedItem, formatDuration } from "../../types";
import type { LibraryCounts, DownloadFilter } from "../../hooks/useLibraryOverview";
import type { View } from "./navigation";

interface Props {
  input: string;
  onInput: (text: string) => void;
  onParse: (text: string) => void;
  parsing: boolean;
  counts: LibraryCounts | null;
  countsError: boolean;
  refreshCounts: () => void;
  onNavigate: (view: View) => void;
  onDownloads: (filter: DownloadFilter) => void;
  onSelect: (item: ParsedItem) => void;
  revision: number;
}
const avatar = new URL("../../assets/avatar.png", import.meta.url).href;

export function HomePage(p: Props) {
  const [recent, setRecent] = useState<ParsedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    invoke<ParseHistoryEntry[]>("get_parse_history", { page: 1 }).then(rows => { if (active) setRecent(rows.slice(0, 4).map(dbToParsedItem)); })
      .catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [p.revision, retry]);

  const cards = [
    { label: "进行中的下载", value: p.counts ? p.counts.downloading + p.counts.queued : null, hint: "下载中与排队中", Icon: Download, action: () => p.onDownloads(null) },
    { label: "已完成的任务", value: p.counts?.done, hint: "查看本地下载记录", Icon: FolderCheck, action: () => p.onDownloads("done") },
    { label: "解析历史", value: p.counts?.parses, hint: "回到感兴趣的内容", Icon: History, action: () => p.onNavigate("history") },
  ] as const;

  return <div className="workspace-page home-page">
    <header className="workspace-page-heading"><div><span className="workspace-eyebrow">未雨 · 内容工作台</span><h1>把喜欢的内容留在身边</h1><p>从一条链接开始，也可以接着上次的发现。</p></div><img src={avatar} alt="未雨" className="home-mascot" /></header>
    <section className="home-intake" aria-labelledby="home-intake-heading"><div className="home-intake-caption"><h2 id="home-intake-heading">添加视频链接</h2><span>单集 · 合集 · 番剧 · 专栏</span></div>
      <DownloadInput value={p.input} onChange={p.onInput} onParse={p.onParse} isParsing={p.parsing} />
      <p>复制 B 站链接后切回窗口，会自动填入；也支持拖入链接。</p>
    </section>
    <div className="home-overview">{cards.map(card => <button type="button" className="overview-card" key={card.label} onClick={card.action}><span className="overview-card-icon"><card.Icon size={19} /></span><div><span>{card.label}</span><strong>{card.value ?? "—"}</strong><small>{card.hint}</small></div><ArrowUpRight size={15} /></button>)}</div>
    {p.countsError && <div className="workspace-inline-error">统计暂时无法读取<button type="button" onClick={p.refreshCounts}>重新加载</button></div>}
    <section className="home-recent" aria-labelledby="home-recent-heading"><div className="section-heading"><div><h2 id="home-recent-heading">最近解析</h2><p>点击继续查看视频、选集和下载选项</p></div><button type="button" onClick={() => p.onNavigate("history")}>全部记录<ChevronRight size={15} /></button></div>
      {loading ? <div className="workspace-empty"><Loader2 size={22} className="animate-spin" /><p>正在读取最近记录</p></div> : error ? <div className="workspace-empty"><RefreshCw size={25} /><p>暂时无法读取记录</p><button type="button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : recent.length === 0 ? <div className="workspace-empty home-empty"><span className="empty-icon"><History size={25} /></span><h3>从第一个喜欢的视频开始</h3><p>粘贴链接后，这里会保留你的解析记录。</p><button type="button" onClick={() => p.onNavigate("explore")}>去发现内容<ArrowUpRight size={14} /></button></div> : <div className="home-recent-grid">{recent.map(item => <button type="button" key={item.id} className="home-recent-card" onClick={() => p.onSelect(item)}>
        {item.videoInfo?.pic ? <img src={item.videoInfo.pic} alt="" loading="lazy" /> : <span className="recent-cover-placeholder"><History size={24} /></span>}
        <span><strong>{item.title}</strong><small>{item.videoInfo?.owner_name || "B 站视频"}</small><span className="recent-meta"><Clock3 size={12} />{item.videoInfo?.duration ? formatDuration(item.videoInfo.duration) : "查看详情"}{(item.videoInfo?.pages.length ?? 0) > 1 && <em>{item.videoInfo!.pages.length} 集</em>}</span></span><ChevronRight size={15} />
      </button>)}</div>}
    </section>
  </div>;
}
