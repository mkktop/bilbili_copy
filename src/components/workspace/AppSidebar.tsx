import { House, Compass, Download, Library, History, Settings2, ChartNoAxesCombined, Search, Sparkles, Trophy, LayoutGrid, CalendarDays, Rss, LogIn, ChevronRight } from "lucide-react";
import type { UserInfo } from "../../hooks/useLogin";
import { DISCOVERY_VIEWS, type View } from "./navigation";

interface Props {
  view: View;
  activeDownloads: number | null;
  hasUpdate: boolean;
  user: UserInfo | null;
  onNavigate: (view: View) => void;
  onLogin: () => void;
}

export function AppSidebar({ view, activeDownloads, hasUpdate, user, onNavigate, onLogin }: Props) {
  const primary = [
    { view: "main", label: "工作台", Icon: House },
    { view: "explore", label: "发现", Icon: Compass },
    { view: "downloads", label: "下载管理", Icon: Download },
    { view: "profile", label: "我的资料库", Icon: Library },
    { view: "history", label: "解析历史", Icon: History },
  ] as const;
  return <aside className="app-sidebar" aria-label="主导航">
    <div className="sidebar-intro"><span className="sidebar-eyebrow">你的内容空间</span><p>发现，观看，收藏。</p></div>
    <nav className="sidebar-links" aria-label="工作区">
      {primary.map(item => {
        const active = item.view === "explore" ? DISCOVERY_VIEWS.includes(view) : item.view === view;
        return <button key={item.view} type="button" aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label}
          onClick={() => onNavigate(item.view)}><item.Icon size={19} /><span>{item.label}</span>
          {item.view === "downloads" && activeDownloads != null && activeDownloads > 0 && <small>{activeDownloads}</small>}
        </button>;
      })}
    </nav>
    <div className="sidebar-note"><span>未雨绸缪</span><p>让喜欢的内容，<br />随时可以再见。</p></div>
    <nav className="sidebar-tools" aria-label="应用工具">
      <button type="button" onClick={() => onNavigate("stats")} aria-current={view === "stats" ? "page" : undefined} aria-label="下载统计" title="下载统计"><ChartNoAxesCombined size={18} /><span>下载统计</span></button>
      <button type="button" onClick={() => onNavigate("settings")} aria-current={view === "settings" ? "page" : undefined} aria-label="设置" title="设置"><Settings2 size={18} /><span>设置</span>{hasUpdate && <i aria-label="有可用更新" />}</button>
    </nav>
    <button type="button" className="sidebar-account" title={user ? user.uname : "登录 B 站账号"} onClick={user ? () => onNavigate("profile") : onLogin}>
      {user ? <img src={user.face} alt="" /> : <span className="sidebar-login-icon"><LogIn size={18} /></span>}
      <span><strong>{user?.uname || "登录 B 站"}</strong><small>{user ? "查看我的收藏与关注" : "同步收藏、动态与观看记录"}</small></span><ChevronRight size={14} />
    </button>
  </aside>;
}

export function DiscoveryNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const items = [
    { view: "explore", label: "搜索", Icon: Search }, { view: "recommend", label: "推荐", Icon: Sparkles },
    { view: "ranking", label: "排行榜", Icon: Trophy }, { view: "region", label: "分区", Icon: LayoutGrid },
    { view: "weekly", label: "每周必看", Icon: CalendarDays }, { view: "dynamic", label: "关注动态", Icon: Rss },
  ] as const;
  return <nav className="discovery-nav" aria-label="发现内容导航">{items.map(item => <button type="button" key={item.view} aria-current={view === item.view ? "page" : undefined} onClick={() => onNavigate(item.view)}><item.Icon size={15} />{item.label}</button>)}</nav>;
}
