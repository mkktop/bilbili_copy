export type DownloadStatus = "pending" | "parsing" | "downloading" | "done" | "error";

export interface DownloadEntry {
  id: string;
  url: string;
  title: string;
  status: DownloadStatus;
  progress?: number;
  errorMsg?: string;
}
