import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft, Loader2, AlertCircle, FileDown, Printer, User, Clock, FileText,
} from "lucide-react";
import type { ArticleData } from "../types";
import { formatDate } from "../types";
import { useToast } from "./Toast";
import { friendlyError } from "../lib/errors";

interface Props {
  /** 传统专栏 cv 号（opus 图文时为 0） */
  cvid: number;
  /** opus 图文 id（字符串：19 位数超 JS 安全整数）；传统专栏不传 */
  opusId?: string;
  onBack: () => void;
}

/** 净化白名单：仅保留内容类标签，其余（script/iframe/style…）丢弃但保留子内容 */
const ALLOWED_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S",
  "BLOCKQUOTE", "UL", "OL", "LI", "A", "IMG", "FIGURE", "FIGCAPTION", "HR",
  "BR", "SPAN", "DIV", "CODE", "PRE",
]);
/** 危险标签：连子内容一起丢弃 */
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);

/** HTML 属性值转义：src/href 内插前必须调用，防止属性逃逸注入 onerror 等 */
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 图片地址规范化：data-src 懒加载属性优先，// 前缀补 https: */
function imgSrc(el: Element): string {
  const raw = el.getAttribute("data-src") || el.getAttribute("src") || "";
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("http://")) return raw.replace("http://", "https://");
  return raw;
}

/** 净化专栏 HTML：DOMParser 解析后按白名单重建（去脚本/事件/多余属性） */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const build = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const div = document.createElement("div");
      div.textContent = node.textContent ?? "";
      return div.innerHTML; // 借 DOM 做 HTML 转义
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (DROP_TAGS.has(el.tagName)) return "";
    const children = Array.from(el.childNodes).map(build).join("");
    if (!ALLOWED_TAGS.has(el.tagName)) return children; // 未知标签解包
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const src = escAttr(imgSrc(el));
      return src ? `<img src="${src}" loading="lazy"/>` : "";
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const safe = href.startsWith("http") || href.startsWith("//") ? href : "";
      return safe
        ? `<a href="${escAttr(safe.startsWith("//") ? `https:${safe}` : safe)}" target="_blank" rel="noreferrer">${children}</a>`
        : children;
    }
    if (tag === "br" || tag === "hr") return `<${tag}/>`;
    return `<${tag}>${children}</${tag}>`;
  };
  return Array.from(doc.body.childNodes).map(build).join("");
}

/** 专栏 HTML → Markdown（DOM 递归，覆盖常见标签；未知标签取纯文本） */
function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (DROP_TAGS.has(el.tagName)) return "";
    const children = () => Array.from(el.childNodes).map(inline).join("");
    switch (el.tagName) {
      case "STRONG": case "B": {
        const t = children().trim();
        return t ? `**${t}**` : "";
      }
      case "EM": case "I": {
        const t = children().trim();
        return t ? `*${t}*` : "";
      }
      case "S": {
        const t = children().trim();
        return t ? `~~${t}~~` : "";
      }
      case "CODE": {
        const t = children().trim();
        return t ? `\`${t}\`` : "";
      }
      case "A": {
        const href = el.getAttribute("href") ?? "";
        const t = children().trim();
        return href.startsWith("http") ? `[${t || href}](${href})` : t;
      }
      case "IMG": {
        const src = imgSrc(el);
        return src ? `![](${src})` : "";
      }
      case "BR": return "\n";
      default: return children();
    }
  };
  const block = (node: Node, listDepth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      return t ? `${t}\n\n` : "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (DROP_TAGS.has(el.tagName)) return "";
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return `${"#".repeat(level)} ${inline(el).trim()}\n\n`;
    }
    switch (tag) {
      case "P": case "FIGCAPTION": {
        const t = inline(el).trim();
        return t ? `${t}\n\n` : "";
      }
      case "HR": return "---\n\n";
      case "BLOCKQUOTE": {
        const innerText = Array.from(el.childNodes).map((c) => block(c, listDepth)).join("").trim();
        return innerText
          ? innerText.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n"
          : "";
      }
      case "UL": case "OL": {
        let out = "";
        let idx = 1;
        for (const li of Array.from(el.children)) {
          if (li.tagName !== "LI") continue;
          const marker = tag === "OL" ? `${idx++}.` : "-";
          const t = inline(li).trim();
          if (t) out += `${"  ".repeat(listDepth)}${marker} ${t}\n`;
        }
        return out ? `${out}\n` : "";
      }
      case "PRE": {
        const t = (el.textContent ?? "").trimEnd();
        return t ? `\`\`\`
${t}
\`\`\`

` : "";
      }
      case "IMG": {
        const src = imgSrc(el);
        return src ? `![](${src})\n\n` : "";
      }
      case "FIGURE": case "DIV": case "SPAN":
        return Array.from(el.childNodes).map((c) => block(c, listDepth)).join("");
      default: {
        const t = inline(el).trim();
        return t ? `${t}\n\n` : "";
      }
    }
  };
  return Array.from(doc.body.childNodes)
    .map((n) => block(n))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 专栏阅读页：全屏覆盖层。导出 Markdown 落盘到下载目录；导出 PDF 走系统打印对话框。 */
export function ArticleReaderPage({ cvid, opusId, onBack }: Props) {
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [safeHtml, setSafeHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setArticle(null);
    invoke<ArticleData>("get_article_content", { cvid: opusId ? null : cvid, opusId: opusId ?? null })
      .then((a) => {
        if (!active) return;
        setArticle(a);
        setSafeHtml(sanitizeHtml(a.content_html));
      })
      .catch((e) => { if (active) setError(friendlyError(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cvid, opusId]);

  /** 导出 Markdown：标题/作者元信息 + 正文转换，后端落盘到下载目录 */
  const exportMarkdown = useCallback(async () => {
    if (!article || exporting) return;
    setExporting(true);
    try {
      const body = htmlToMarkdown(article.content_html);
      const meta = [
        `# ${article.title}`,
        "",
        `> 作者：${article.author_name} · 发布：${formatDate(article.publish_time)} · 来源：${article.opus_id ? `https://www.bilibili.com/opus/${article.opus_id}` : `https://www.bilibili.com/read/cv${article.cvid}`}`,
        "",
      ].join("\n");
      const path = await invoke<string>("export_article_markdown", {
        cvid: article.cvid,
        opusId: article.opus_id || null,
        title: article.title,
        markdown: `${meta}\n${body}\n`,
      });
      toast.success(`Markdown 已导出：${path}`);
    } catch (e) {
      toast.error(`导出失败：${friendlyError(e)}`);
    } finally {
      setExporting(false);
    }
  }, [article, exporting, toast]);

  /** 导出 PDF：离屏 iframe 装载纯净文章文档后调用其 print()（选「Microsoft Print to PDF」即存为 PDF）。
   *  不能直接 window.print()：阅读页是 fixed 全屏覆盖层，Chromium 打印 fixed 容器
   *  只输出首屏一页（后续内容被截断）；iframe 内是普通文档流，多页内容正常分页。 */
  const exportPdf = useCallback(() => {
    if (!article) return;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const metaLine = [
      article.author_name,
      article.publish_time > 0 ? formatDate(article.publish_time) : "",
      article.opus_id ? "opus" : `cv${article.cvid}`,
    ].filter(Boolean).join(" · ");
    // lazy → eager：0 尺寸 iframe 里懒加载图片永不触发加载，会导致 PDF 图片空白
    const bodyHtml = safeHtml.replace(/loading="lazy"/g, 'loading="eager"');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(article.title)}</title><style>
      body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #111827; margin: 24px; line-height: 1.75; font-size: 15px; }
      h1.doc-title { font-size: 24px; margin: 0 0 8px; }
      .doc-meta { color: #6b7280; font-size: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 16px; }
      img { max-width: 100%; height: auto; display: block; margin: 12px auto; }
      blockquote { border-left: 4px solid #d1d5db; padding-left: 12px; color: #6b7280; margin: 12px 0; }
      pre { background: #f3f4f6; border-radius: 8px; padding: 12px; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
      code { color: #ec4899; }
      a { color: #3b82f6; }
      h1, h2, h3 { margin: 20px 0 8px; }
      p { margin: 10px 0; }
      /* 分页友好：图片/引用块尽量不跨页拆断 */
      img, blockquote, pre { break-inside: avoid; }
    </style></head><body>
      <h1 class="doc-title">${esc(article.title)}</h1>
      <div class="doc-meta">${esc(metaLine)}</div>
      ${article.banner_url ? `<img src="${escAttr(article.banner_url)}"/>` : ""}
      ${bodyHtml}
    </body></html>`;

    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const cleanup = () => { setTimeout(() => iframe.remove(), 100); };
    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) { cleanup(); return; }
      // 等全部图片加载完再弹打印对话框（否则 PDF 里图片空白）；5s 超时兑底不卡死
      const imgs = Array.from(doc.images);
      const allLoaded = Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); })
        )
      );
      void Promise.race([allLoaded, new Promise((res) => setTimeout(res, 5000))]).then(() => {
        win.addEventListener("afterprint", cleanup, { once: true });
        win.focus();
        win.print();
      });
    };
    iframe.srcdoc = html;
  }, [article, safeHtml]);

  return (
    <div className="fixed inset-0 z-[80] bg-base text-ink flex flex-col">
      <header className="flex items-center gap-3 px-6 py-4 bg-panel border-b border-line shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg border border-line-2 hover:bg-base transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <FileText size={18} className="text-blue-500" />
        <h1 className="text-lg font-semibold text-ink truncate flex-1">
          {article?.title ?? (opusId ? "B站图文" : `专栏 cv${cvid}`)}
        </h1>
        <button
          onClick={exportMarkdown}
          disabled={!article || exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
        >
          {exporting ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />}
          导出 Markdown
        </button>
        <button
          onClick={exportPdf}
          disabled={!article}
          title="打开打印对话框，选「Microsoft Print to PDF」即可保存为 PDF"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
        >
          <Printer size={12} />
          导出 PDF
        </button>
      </header>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-ink-3">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">加载专栏中...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-ink-3">
            <AlertCircle size={24} />
            <p className="text-sm">{error}</p>
          </div>
        ) : article ? (
          <article className="max-w-3xl mx-auto px-8 py-8">
            <h1 className="text-2xl font-bold text-ink leading-snug">{article.title}</h1>
            <div className="flex items-center gap-4 mt-3 pb-4 border-b border-line text-xs text-ink-3">
              <span className="flex items-center gap-1">
                <User size={12} />
                {article.author_name}
              </span>
              {article.publish_time > 0 && (
                <span className="flex items-center gap-1">
                  <Clock size={12} />
                  {formatDate(article.publish_time)}
                </span>
              )}
              {article.words > 0 && <span>{article.words} 字</span>}
              <span>{article.opus_id ? `opus` : `cv${article.cvid}`}</span>
            </div>
            {article.banner_url && (
              <img src={article.banner_url} alt="" className="w-full rounded-lg mt-4" />
            )}
            {/* 正文：白名单净化后的 HTML；prose 风格排版 */}
            <div
              className="article-body mt-4 text-[15px] leading-7 text-ink-2
                [&_p]:my-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3
                [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-6 [&_h2]:mb-3
                [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2
                [&_img]:rounded-lg [&_img]:my-3 [&_img]:max-w-full [&_img]:mx-auto
                [&_blockquote]:border-l-4 [&_blockquote]:border-line-2 [&_blockquote]:pl-3 [&_blockquote]:text-ink-3 [&_blockquote]:my-3
                [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3
                [&_a]:text-blue-500 [&_a]:underline [&_hr]:my-6 [&_hr]:border-line
                [&_pre]:bg-panel-2 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-auto [&_pre]:text-xs
                [&_code]:text-pink-500"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          </article>
        ) : null}
      </div>
    </div>
  );
}
