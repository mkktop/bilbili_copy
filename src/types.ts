export type DownloadStatus = "pending" | "parsing" | "downloading" | "done" | "error";

export interface VideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
  bvid?: string;
  ep_id?: number;
}

export interface ParsedVideoInfo {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pic: string;
  owner_mid: number;
  owner_name: string;
  owner_face: string;
  duration: number;
  pages: VideoPage[];
  ep_id?: number;
  extra_pages?: VideoPage[];
  view_count?: number;
  danmaku_count?: number;
}

export interface DownloadEntry {
  id: string;
  url: string;
  title: string;
  status: DownloadStatus;
  progress?: number;
  errorMsg?: string;
  videoInfo?: ParsedVideoInfo;
}

/** 解析列表条目 */
export interface ParsedItem {
  id: string;
  url: string;
  title: string;
  status: "parsing" | "pending" | "error";
  errorMsg?: string;
  videoInfo?: ParsedVideoInfo;
}

/** 下载任务条目 */
export interface DownloadTask {
  id: string;
  title: string;
  status: "downloading" | "done" | "error";
  progress?: number;
  errorMsg?: string;
}

/** 格式化秒数为 mm:ss 或 hh:mm:ss */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
