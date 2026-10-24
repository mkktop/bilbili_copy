import React from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer } from "../../src/components/VideoPlayer";
import { ToastProvider } from "../../src/components/Toast";
import { LoginProvider } from "../../src/hooks/useLogin";
import { VideoDetail } from "../../src/components/VideoDetail";
import type { ParsedVideoInfo, PlaylistItem, VideoPage } from "../../src/types";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
const pages: VideoPage[] = [1, 2, 3].map(n => ({ page: n, cid: n, part: `第 ${n} 集 · 山湖之间，记录一段安静的旅程`, duration: 12 }));
const info: ParsedVideoInfo = {
  bvid: "BVfixture0", aid: 100, title: "在山湖之间，记录一段安静的旅程", desc: "沿着湖岸慢慢走，山就映在水里。\n用镜头收集日常的片刻。", pic: "", owner_mid: 100,
  owner_name: "山野来信", owner_face: "", duration: 12, pages, view_count: 128000, danmaku_count: 860, like_count: 2341,
};
const playlist: PlaylistItem[] = pages.map((p, i) => ({ bvid: `BVfixture${i}`, aid: 100 + i, cid: p.cid, title: p.part, duration: 12 }));
const state = { calls: [] as { cmd: string; args: any }[], backCount: 0, downloads: [] as VideoPage[], playRequests: [] as unknown[], failStreams: params.has("error"), slowIndex: false };
(window as any).__fixture = state;
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: any) => {
    state.calls.push({cmd, args});
    switch (cmd) {
      case "login_check": return null;
      case "get_play_streams":
        if (state.failStreams) throw new Error("拉流失败 HTTP 403");
        return { qualities: [
          { qn: 80, label: "1080P", codec: "AVC", video_url: "https://fixture.invalid/1080.mp4" },
          { qn: 64, label: "720P", codec: "AVC", video_url: "https://fixture.invalid/720.mp4" },
        ], audio_url: "https://fixture.invalid/audio.mp4", has_audio: true, default_qn: 80, duration: 12 };
      case "get_seek_index":
        if (state.slowIndex && args.videoUrl.includes("720")) await new Promise(resolve => setTimeout(resolve, 600));
        return (window as any).__seekIndex ?? {video: null, audio: null};
      case "get_play_progress": return null;
      case "get_videoshot": return { images: [], index: [], img_x_len: 1, img_y_len: 1, img_x_size: 160, img_y_size: 90 };
      case "get_danmaku_json": return [{ time: 0, mode: 5, text: "一起记录旅途的风景", color: "#ffffff" }];
      case "get_subtitle_list": return [{ lan: "zh-CN", lan_doc: "中文", is_ai: true, subtitle_url: "https://fixture.invalid/sub" }];
      case "get_subtitle_cues": return [{ from: 0, to: 12, content: "沿着湖岸慢慢走，山就映在水里。" }];
      case "get_ai_summary": return { summary: ["一段关于山、湖泊和慢生活的记录。"], outline: [{ title: "旅途中的片刻", parts: [{ timestamp: 4, content: "在湖边停下脚步" }] }] };
      case "get_related_videos": return [];
      case "get_video_comments": return { items: [], has_more: false, total: 0 };
      case "parse_video": return { ...info, bvid: args.urlStr.split("/").pop() };
      default: return null;
    }
  },
};

createRoot(document.getElementById("root")!).render(<React.StrictMode><ToastProvider><LoginProvider>
  <div id="window-titlebar" style={{ height: 40, display: "flex", alignItems: "center", padding: "0 20px", background: "#17191f", color: "#dce5f7", fontSize: 13 }}>☂　未雨 <span style={{marginLeft:'auto'}}>—　 □　 ×</span></div>
  <button id="underlying-button">底层页面按钮</button>
  {params.has("detail") ? <VideoDetail entry={{id:"fixture",url:"",title:info.title,status:"pending",videoInfo:info}} sourceLabel="测试"
    onBack={() => state.backCount++} onPlay={item => state.playRequests.push(item)} onDownload={async () => true} /> : <VideoPlayer bvid={info.bvid} aid={info.aid} cid={1} duration={12} title={info.title} videoInfo={info}
    pages={params.has("playlist") ? undefined : pages} playlist={params.has("playlist") ? playlist : undefined}
    onDownload={async (_, page) => { state.downloads.push(page); return true; }} onBack={() => state.backCount++} />}
</LoginProvider></ToastProvider></React.StrictMode>);
