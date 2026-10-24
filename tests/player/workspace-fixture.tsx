import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import App from "../../src/App";
import { UpdateProvider } from "../../src/contexts/UpdateContext";
import { ToastProvider } from "../../src/components/Toast";
import { LoginProvider } from "../../src/hooks/useLogin";
import type { AppSettings } from "../../src/hooks/useSettings";
import type { DownloadHistoryEntry, ParsedVideoInfo, ParseHistoryEntry } from "../../src/types";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
const cover = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${color}"/><circle cx="240" cy="48" r="21" fill="#f7e6c6" opacity=".8"/><path d="M0 145L90 53 176 144 246 91 320 150V180H0" fill="#193f55" opacity=".7"/><path d="M0 163L74 117 156 171 254 125 320 157V180H0" fill="#193f55" opacity=".6"/></svg>`)}`;
const colors = ["#789aaf", "#99a8a0", "#ac9dac", "#7595a8"];
const titles = ["在山湖之间，记录一段安静的旅程", "下班后的十分钟，给自己做一顿晚餐", "从零整理工作空间，让桌面回到舒适的样子", "沿着海岸走，直到落日与风相遇"];
const infos: ParsedVideoInfo[] = titles.map((title, i) => ({ bvid: `BVfixture${i}`, aid: 100 + i, title, desc: "记录生活里的片刻，也收藏值得再看的内容。", pic: cover(colors[i]), owner_mid: 100 + i, owner_name: ["山野来信", "一人食日记", "工作与生活", "沿途记录"][i], owner_face: cover(colors[i]), duration: 620 + i * 83, pages: [{cid: i + 1, page: 1, part: title, duration: 620 + i * 83}], view_count: 128000, danmaku_count: 860, like_count: 2341 }));
const history: ParseHistoryEntry[] = infos.map((video_info, i) => ({id:`parse-${i}`,url:`https://www.bilibili.com/video/${video_info.bvid}`,title:video_info.title,video_info,created_at:"2026-10-24T00:00:00Z"}));
const initialSettings: AppSettings = {
  default_download_dir: "D:\\Videos\\Weiyu", auto_update: false, update_channel: "r2", theme: params.has("dark") ? "dark" : "light",
  video_max_quality: 127, video_min_quality: 0, audio_max_quality: 30251, audio_min_quality: 0, video_codec_priority: ["AVC", "HEV", "AV1"],
  max_concurrent_downloads: 2, max_pages_per_video: 2, parallel_threads: 4, max_download_speed_kbps: 0, audio_format: "m4a", close_to_tray: true, tray_hint_shown: true, notify_on_complete: true,
  fingerprint_gpu_preset: "", fingerprint_resolution_preset: "", dm_img_str: "", dm_cover_img_str: "", dm_img_list: "", dm_img_inter: "", request_delay_ms: 350,
  download_danmaku: true, download_subtitle: true, danmaku_font_size: 25, danmaku_scroll_duration: 15, danmaku_opacity: .5, danmaku_block_top: false, danmaku_block_bottom: false, danmaku_history_days: 0,
  subtitle_format: "srt", filename_template: "", download_nfo: false, nfo_include_genre: true, nfo_include_actor: true, nfo_include_stats: true, subscription_check_interval_min: 0, mcp_enabled: false, mcp_rate_limit_per_sec: 2,
};
const downloads: DownloadHistoryEntry[] = ["downloading", "queued", "paused", "done", "error", "done"].map((status, i) => ({ id:`download-${i}`,title:infos[i % 4].title,bvid:infos[i % 4].bvid,cid:i+1,ep_id:null,status,progress:status==="done"?100:43,phase:status==="downloading"?"video":null,error_msg:status==="error"?"网络连接超时，请重试":null,output_path:status==="done"?"D:\\Videos\\Weiyu\\sample.mp4":null,pic:infos[i%4].pic,created_at:"2026-10-24T00:00:00Z",video_title:infos[i%4].title }));
const user = { mid: 100, uname: "山野来信", face: cover(colors[0]), level: 5, coins: 128, sign: "记录每一份喜欢。", vip: true, following: 123, follower: 2486, sex: "保密" };
const state = {
  settings: initialSettings, history: params.has("empty") ? [] : history, downloads: params.has("empty") ? [] : downloads,
  counts: params.has("empty") ? {all:0,queued:0,downloading:0,paused:0,done:0,error:0} : {all:123,queued:12,downloading:3,paused:8,done:96,error:4},
  calls: [] as {cmd: string; args: any}[], failSave: false, failPatch: false, failHistory: false, failCounts: false, saveDelay: 0, delayedFilters: false,
  suggestionRace: false, loggedIn: params.has("logged"), emit, paginateDownloads: false, statusWriteDelay: 0,
};
(window as any).__workspace = state;
mockWindows("main");
mockIPC(async (cmd, payload: any) => {
  state.calls.push({cmd, args:payload});
  switch(cmd) {
    case "plugin:app|version": return "1.5.0";
    case "plugin:window|is_maximized": return false;
    case "plugin:clipboard-manager|read_text": return "";
    case "get_settings": return {...state.settings};
    case "save_settings": if(state.saveDelay) await new Promise(resolve=>setTimeout(resolve,state.saveDelay)); if(state.failSave) throw new Error("磁盘写入失败"); state.settings={...payload.settings}; return null;
    case "patch_settings": if(state.failPatch) throw new Error("设置暂时无法保存"); state.settings={...state.settings,...payload.patch}; return {...state.settings};
    case "login_check": return state.loggedIn ? user : null;
    case "login_generate_qrcode": return {url:"https://example.com/fixture-login",qrcode_key:"fixture"};
    case "login_poll_qrcode": return {status:"pending",user_info:null};
    case "login_logout": state.loggedIn=false; return null;
    case "get_parse_history": if(state.failHistory) throw new Error("读取记录失败"); return state.history;
    case "get_parse_count": return state.history.length ? 89 : 0;
    case "get_download_history": {
      if(state.delayedFilters && payload.status==="downloading") await new Promise(resolve=>setTimeout(resolve,500));
      const rows=state.downloads.filter(item=>!payload.status || item.status===payload.status);
      return state.paginateDownloads ? rows.slice((payload.page-1)*20,payload.page*20) : rows;
    }
    case "update_download_status": {
      if(state.statusWriteDelay) await new Promise(resolve=>setTimeout(resolve,state.statusWriteDelay));
      const row=state.downloads.find(item=>item.id===payload.id);
      if(row) row.status=payload.status;
      return null;
    }
    case "get_download_count": if(state.failCounts) throw new Error("读取数量失败"); return state.counts[(payload.status ?? "all") as keyof typeof state.counts];
    case "get_download_stats": return {total_count:state.counts.all,done_count:state.counts.done,done_size:12400000000,done_duration:34200};
    case "parse_video": return infos[0];
    case "get_article_content": return {cvid:payload.cvid ?? 0,opus_id:payload.opusId ?? "",title:"测试专栏文章",author_name:"测试作者",author_mid:100,publish_time:0,words:12,banner_url:"",content_html:"<p>用于验证页面导航的本地文章。</p>"};
    case "get_related_videos": return [];
    case "get_ai_summary": return null;
    case "get_video_comments": return {items:[],total:0,has_more:false};
    case "get_search_history": return ["旅行记录", "桌面整理", "一人食"];
    case "get_hot_search": return [{keyword:"秋日旅行",show_name:"秋日旅行",icon:""},{keyword:"生活记录",show_name:"生活记录",icon:""},{keyword:"桌面改造",show_name:"桌面改造",icon:""}];
    case "get_search_suggest": if(state.suggestionRace && payload.term==="旧词") await new Promise(resolve=>setTimeout(resolve,600)); return [`${payload.term} 推荐`,`${payload.term} 教程`];
    case "search_videos": return {results:[],total:0,num_pages:0,page:1};
    case "get_recommend": case "get_ranking": case "get_region": case "get_pgc_rank": return [];
    case "get_dynamic_feed": return {items:[],offset:"",has_more:false};
    case "get_weekly_series": return [];
    case "get_favorite_folders": return [{id:1,title:"值得再看的视频",media_count:24},{id:2,title:"生活与旅行",media_count:16},{id:3,title:"学习清单",media_count:32}];
    case "get_favorite_videos": return {medias:[],total:0,has_more:false,page:1};
    case "get_watch_history": return {items:[],cursor:{max:0,view_at:0,business:""},has_more:false};
    case "get_watch_later": case "get_subscriptions": case "get_subscribed_collections": return [];
    case "get_followings": return {items:[],total:0,has_more:false};
    case "get_bangumi_follow": return {items:[],total:0,has_more:false};
    case "get_app_info": return {exe_path:"D:\\Weiyu\\Weiyu.exe"};
    case "get_fingerprint_presets": return {gpus:[],resolutions:[]};
    case "check_app_update": return null;
    default: return null;
  }
}, {shouldMockEvents:true});

createRoot(document.getElementById("root")!).render(<React.StrictMode><UpdateProvider><ToastProvider><LoginProvider><App /></LoginProvider></ToastProvider></UpdateProvider></React.StrictMode>);
