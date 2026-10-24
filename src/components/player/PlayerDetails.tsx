import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Check, Loader2, ChevronDown, Sparkles, Eye, MessageSquare } from "lucide-react";
import type { ParsedVideoInfo, VideoPage, AiSummary } from "../../types";
import { formatDuration } from "../../types";
import { formatCount } from "../VideoCard";
import { CommentSection } from "../CommentSection";
import { InteractionBar } from "../InteractionBar";

interface Props {
  info: ParsedVideoInfo | null;
  title: string;
  page: VideoPage;
  onSeek: (time: number) => void;
  onDownload?: (info: ParsedVideoInfo, page: VideoPage) => Promise<boolean>;
}

export function PlayerDetails({ info, title, page, onSeek, onDownload }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [tab, setTab] = useState<"comments" | "chapters">("comments");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  useEffect(() => {
    setExpanded(false); setSubmitted(false); setBusy(false); setDownloadError(""); setSummary(null);
    if (!info) return;
    let active = true;
    invoke<AiSummary | null>("get_ai_summary", { bvid: info.bvid, cid: page.cid, upMid: info.owner_mid })
      .then(result => { if (active) setSummary(result); }).catch(() => {});
    return () => { active = false; };
  }, [info, page.cid]);

  const download = async () => {
    if (!info || !onDownload || busy) return;
    setBusy(true); setDownloadError("");
    try { setSubmitted(await onDownload(info, page)); }
    catch { setDownloadError("下载提交失败，请重试"); }
    finally { setBusy(false); }
  };

  return <section className="watch-details" aria-label="视频信息">
    <h1>{title}</h1>
    <div className="watch-meta">
      {info?.view_count != null && <span><Eye size={14} />{formatCount(info.view_count)} 次播放</span>}
      {info?.danmaku_count != null && <span><MessageSquare size={14} />{formatCount(info.danmaku_count)} 条弹幕</span>}
      {page.duration > 0 && <span>{formatDuration(page.duration)}</span>}
      {info?.pubdate ? <span>{new Date(info.pubdate * 1000).toLocaleDateString("zh-CN")}</span> : null}
    </div>
    <div className="watch-owner-row">
      <div className="watch-owner">
        {info?.owner_face ? <img src={info.owner_face} alt="" /> : <div className="watch-avatar">{info?.owner_name?.slice(0, 1) || "未"}</div>}
        <div><strong>{info?.owner_name || "正在获取视频信息"}</strong><span>{info?.series_title || "记录每一份喜欢"}</span></div>
      </div>
      {onDownload && <button type="button" className="watch-download" disabled={!info || busy || submitted} onClick={() => void download()}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : submitted ? <Check size={16} /> : <Download size={16} />}
        {submitted ? "已加入下载" : busy ? "正在提交" : "下载当前视频"}
      </button>}
    </div>
    {downloadError && <p role="alert" className="watch-inline-error">{downloadError}</p>}
    {info && <div className="watch-interactions"><InteractionBar key={info.bvid} bvid={info.bvid} aid={info.aid} likeCount={info.like_count} /></div>}
    {info?.desc && <div className="watch-description"><p className={expanded ? "" : "line-clamp-2"}>{info.desc}</p><button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>{expanded ? "收起简介" : "展开简介"}<ChevronDown size={13} className={expanded ? "rotate-180" : ""} /></button></div>}
    <div className="watch-detail-tabs" role="tablist" aria-label="视频内容">
      <button type="button" id="watch-comments-tab" role="tab" aria-controls="watch-comments" aria-selected={tab === "comments"} onClick={() => setTab("comments")}>评论</button>
      <button type="button" id="watch-chapters-tab" role="tab" aria-controls="watch-chapters" aria-selected={tab === "chapters"} onClick={() => setTab("chapters")}><Sparkles size={14} />AI 章节</button>
    </div>
    <div id="watch-comments" role="tabpanel" aria-labelledby="watch-comments-tab" hidden={tab !== "comments"}>
      {info && <CommentSection key={info.aid} aid={info.aid} />}
    </div>
    <div id="watch-chapters" role="tabpanel" aria-labelledby="watch-chapters-tab" hidden={tab !== "chapters"} className="watch-chapters">
      {!summary && <p>这个视频暂时没有可用的 AI 章节。</p>}
      {summary?.summary.map((text, i) => <p key={i}>{text}</p>)}
      {summary?.outline.map((section, i) => <div key={i}><h3>{section.title}</h3>{section.parts.map((part, j) => <button type="button" key={j} onClick={() => onSeek(part.timestamp)}><time>{formatDuration(part.timestamp)}</time><span>{part.content}</span></button>)}</div>)}
    </div>
  </section>;
}
