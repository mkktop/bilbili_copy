import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type DownloadFilter = "queued" | "downloading" | "paused" | "done" | "error" | null;
export type LibraryCounts = Record<"all" | "queued" | "downloading" | "paused" | "done" | "error" | "parses", number>;

/** Counts come from the database, never from one paginated page of rows. */
export function useLibraryOverview(revision: string) {
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const filters = [null, "queued", "downloading", "paused", "done", "error"] as const;
        const values = await Promise.all([
          ...filters.map(status => invoke<number>("get_download_count", { status })),
          invoke<number>("get_parse_count"),
        ]);
        if (active) {
          const [all, queued, downloading, paused, done, errorCount, parses] = values;
          setCounts({ all, queued, downloading, paused, done, error: errorCount, parses }); setError(false);
        }
      } catch { if (active) setError(true); }
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [revision, refreshKey]);
  return { counts, error, refresh };
}
