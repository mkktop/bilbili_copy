# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
pnpm dev              # Start Tauri dev (Rust + Vite frontend)
pnpm build            # Production build (Tauri bundle)
pnpm typecheck        # TypeScript check (frontend only) — primary frontend gate
pnpm build:renderer   # Vite build only (frontend bundle, no Rust)
cd src-tauri && cargo check     # Rust compilation check — primary backend gate
cd src-tauri && cargo test --lib  # Rust unit tests (~69: download engine, scheduler, db migrations, batch dedup)
```

No separate lint step. `pnpm typecheck` + `cargo check` are the correctness gates before building. `cargo test --lib` exists but is **not** in CI — run it manually when touching `download_manager.rs`, `bilibili/download.rs`, or `db.rs` migrations.

## Version Management

Version must be synced in **three files** before release:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package].version`
- `src-tauri/tauri.conf.json` → `"version"`

Only change version when explicitly asked. CI triggers on `v*` tag push.

**Release flow: batch all changes, then tag once.** Code fixes + version sync must be in a single commit. Only create the tag after confirming everything is ready. Never push multiple tags for the same version — each tag push triggers CI and forces users to update.

**Release notes: write `RELEASE_NOTES.md` before tagging.** CI reads this file as the GitHub Release body and the in-app update changelog. Convention (since v1.0.0): the file holds the **current release's `## vX.X.X 更新内容` section + the v1.0.0 flagship announcement** below it, separated by `---`; older sections are removed from the file when a new release ships (their bodies remain on the GitHub Releases page; 0.x history is archived in `docs/CHANGELOG-0.x.md`). Commit it together with the version bump before tagging.

**Tag push:** use `git push origin v0.X.X` (single tag), not `--tags`. If master has diverged from remote after pushing the tag, **merge** remote (`git merge origin/master`) rather than rebase — rebase moves the already-pushed tagged commit and would require re-pushing the tag (forbidden: re-triggers CI).

## Architecture

Tauri 2 desktop app: Rust backend + React 18 frontend (Vite + Tailwind CSS). A Bilibili video downloader: parse URLs → resolve streams → parallel download → ffmpeg merge, with QR login, danmaku/subtitle/NFO side artifacts, and风控 (risk-control) captcha handling.

### Backend (`src-tauri/src/`) — four top-level layers

1. **`lib.rs`** — app setup: logger init (`init_logger`, `app.log` next to exe), system proxy detection (`init_system_proxy()`, reads Windows registry → sets `HTTPS_PROXY` so the updater can use it), SQLite `init_db()` as managed state, system tray (close-to-tray intercept via `on_window_event`), and the single `generate_handler![]` registering **all** commands. The download scheduler dispatcher is spawned here in `setup`, as is the **subscription scheduler** (60s tick; checks all subscriptions only when `settings.subscription_check_interval_min` > 0 — 0 = off, default). Also hosts the **`biliproxy` custom URI-scheme protocol** + pooled `PROXY_CLIENT` + `proxy_fetch_bytes()` for the online player (see [Online Player](#online-player-mse-在线播放)).

2. **`download_manager.rs`** — **Download scheduler** (decouples submit from execute). `manager()` is a global singleton (`Lazy`). Flow:
   - `download_video` command only **validates + submits** a task to the priority queue, returns immediately.
   - `run_dispatcher` (spawned once in `setup`) loops: read settings → **acquire global permit** (blocks while concurrency full; pop happens after acquire so queue priority always wins) → `pop_highest` (priority desc, seq asc = FIFO) → check cancel → register in `running` → `spawn execute_download` (**the permit is moved into the spawned task and held until it finishes** — this is what actually caps concurrent running tasks; the old code dropped it at the end of the loop iteration, making `max_concurrent_downloads` a no-op).
   - Runtime **pause/cancel** via `CancellationToken` + `TargetState` (Running/Pausing/Cancelling) — determines whether `.tmp` is kept (pause) or cleaned (cancel) and which event is emitted.
   - **Priority adjustment** (`set_download_priority`) only affects queued (not-yet-started) tasks.
   - Lock poisoning is recovered everywhere (`unwrap_or_else(|p| p.into_inner())`) so one panic never permanently wedges scheduling.

3. **`db.rs`** — SQLite persistence (`rusqlite`) via `DbState(Mutex<Connection>)`. Tables: `parse_history`, `download_history`, `download_stats` (cumulative counters), `play_progress`, `search_history`, `subscriptions`, `schema_version`. **Schema is at v102** — v1.0 broke from 0.x data structures (fresh DB on first 1.0 launch, no 0.x migration chain); within 1.x, migrations are incremental (101→102 adds `subscriptions`, data preserved). `download_history.owner_name` keeps the filename template's `{up}` stable across resume/retry. On startup, any `downloading`/`queued` rows are reset to `paused` (orphan cleanup for abnormal exits → user can resume, reusing `.tmp`). WAL + foreign_keys on. Also home of `build_download_dedup` — the batch-download dedup set (key `bvid_cid`; skips done/queued/downloading/paused; `error` rows are reused via their original id).

4. **`commands/`** (26 submodules) — `#[tauri::command]` handlers grouped by domain. The **validation/orchestration** layer; each re-exports commands for `generate_handler![]`. `commands/download.rs` holds `execute_download` (the real download pipeline, called by the dispatcher) + the dynamic concurrency limiters; `commands/player.rs` holds the online-player stream/seek/danmaku commands (independent of the download path); `commands/batch.rs` and `commands/subscription.rs` are the batch-download / subscription-check orchestration (see [Batch Download & Subscriptions](#batch-download--subscriptions-批量下载与订阅追更)).

5. **`bilibili/`** (32 submodules) — core business logic, organized by B站 API domain:
   - **Download pipeline:** `url.rs` (parse bvid/aid/ep/season/media + b23 short-link resolution) → `video.rs` (`get_video_info`, bangumi fallback, main/preview split via `badge_type`) → `playurl.rs` (stream resolution) → `download.rs` (engine).
   - **Online player:** `playurl.rs` (shared with downloads — exposes `all_qualities` for the quality menu), `mp4_seek.rs` (`sidx` box parser → time/byte index for precise seek; player-only, see [Online Player](#online-player-mse-在线播放)), `danmaku.rs` (`fetch_danmaku_list` returns raw JSON for the player's overlay, distinct from its protobuf→ASS path used for downloads), `interaction.rs` (like/coin/favorite POSTs; shared `interaction_post` helper injects csrf in form+cookie, detects `v_voucher` risk, **no auto-retry** on risk — unlike the download path).
   - **`download.rs`** — the engine: parallel Range-based downloading (>4MB → `parallel_threads` Range segments, else single-thread resume), **BufWriter** on all file writes, `.meta` resume bitmap (fingerprint-validated, **flush debounced** to every 8 segments + on interrupt), bad-CDN cache (10-min TTL, multi-URL fallback), `throttle.rs` global byte-rate limiter, ffmpeg merge/remux. Progress emitted every 512KB. Also home of `sanitize_filename` (Windows-safe, path-traversal-proof), reused by `filename.rs`.
   - **`filename.rs`** — download **filename template** renderer (`settings.filename_template`, relative path under download_dir, `/` = subdirs). Placeholders `{title} {video_title} {bvid} {ep} {cid} {up}`; unknown `{ident}` → empty; per-segment `sanitize_filename` + 240-char total guard (trims last segment only). Empty template normalizes to `{video_title}/{title}`, reproducing the historical layout exactly. `{up}` = `owner_name`, a **first-class `download_video` param** (preferred from `video_meta` when present) — persisted in DB so resume/retry rebuild the same output path even with NFO off.
   - **`playurl.rs`** — **single-request fast path**: one `qn=max` request (fnval=4048 returns all qualities in `dash.video`) → `parse_streams` picks best in `[min_qn,max_qn]` with codec priority; per-quality fallback loop only runs if the single request fails. The returned `Streams` also carries `all_qualities` (every resolved quality+codec, not just the picked best) — the online player surfaces all AVC entries as its quality menu. WBI-signed.
   - **Auth/cred:** `passport.rs` (QR login: seed buvid → QR → poll → cookies → validate; `validate_credentials` runs nav + relation **in parallel**), `credential.rs` (`Credential` struct, file persistence — DPAPI-encrypted since v1.0.2, cookie header, **auto-refresh** via RSA→CSRF→3-step→confirm), `wbi.rs` (WBI signature, **mixin key cached with 2h TTL** — shortened from 12h in v1.0.2 so a key fetched just before B站's daily rotation can't go stale for half a day — + fetch-lock to prevent cold-start stampede; auto-refresh on 412/-404).
   - **Side artifacts:** `danmaku.rs` (protobuf → ASS, collision/scroll layout), `subtitle.rs` (player v2 → SRT, AI-sub detection), `nfo.rs` (.nfo + cover thumb/fanart).
   - **Browse/explore** (uniform pattern — call API, parse JSON `Value`, return typed list): `favorite.rs`, `search.rs`, `submission.rs`, `collection.rs`, `following.rs`, `history.rs`, `ranking.rs`, `pgc.rs`, `recommend.rs`, `region.rs`, `comment.rs`, `watch_later.rs`.
   - **Risk control:** `risk_control.rs` (GeeTest v3, `gaia_vtoken` in-memory 1h cache), `fingerprint.rs` (browser/GPU fingerprint generation), `throttle.rs` (download byte-rate limiter — **download-only**, no global API rate limiter).

   Shared in `bilibili/mod.rs`: `USER_AGENT`, `REFERER`, `ORIGIN`, `API_TIMEOUT` (15s), `BilibiliResponse<T>`, `api_client()` (per-call client, `cookie_store(false)`, timeout), `VideoListItem`, `PagedResult`, `http_to_https()`.

Data files next to exe: `settings.json`, `credentials.json`, `data.db`, `app.log` (atomic tmp+rename for settings/credentials).

### Frontend (`src/`)

- **`App.tsx`** — single ~800-line component, **no router**; toggles views via `currentView` state (`"main" | "settings" | "detail" | "downloads" | "stats" | "profile" | "explore" | "ranking" | "recommend" | "region" | "dynamic" | "weekly"`), rendered as an early-return ladder. Holds top-level state (downloads, parsedItems, pagination); **download-event orchestration** is delegated to the `useDownloadEvents` hook (see Conventions). `SettingsPage`/`StatsPanel`/`VideoPlayer` are `React.lazy` + `Suspense` (separate chunks, not in the first-screen bundle). The online player is a **separate** full-screen overlay, not a `currentView`: `VideoDetail.onPlay` sets a `playingItem` object → `VideoPlayer` mounts/unmounts on top of everything.
- **Components:** `DownloadInput`, `ParseList`, `VideoDetail` (AI summary card, related videos, tags, watch-later button), `DownloadList` (rows are `React.memo` with a custom comparator keyed on item fields; shows speed/ETA; header has 全部暂停/重试全部失败), `BatchBar` (shared select-mode toolbar for batch download: 选择 → 全选 → 下载已选), `SettingsPage` (renders `settings/` tabs: General/Quality/Download/**Subtitle (字幕弹幕)**/AntiRisk/About), `LoginDialog`, `CaptchaDialog`, `UserProfilePage` (renders `tabs/`: WatchLater/WatchHistory/Subscriptions/Followings/UpperView — UpperView has submissions/collections/**followers** panes), explore pages (`ExplorePage` with search-suggest dropdown/`RankingPage`/`RecommendPage`/`RegionPage`/`DynamicPage`/`WeeklyPage` — weekly has a 每周必看/入站必刷 segmented switch), `ArticleReaderPage` (专栏), `CommentSection` (sort toggle + lazy 楼中楼 replies), `StatsPanel`, `VideoPlayer` (MSE online player — see [Online Player](#online-player-mse-在线播放)).
- **`VirtualList.tsx`** — reusable windowed list (`@tanstack/react-virtual`): takes a `scrollRef` to the outer `overflow-auto` container, renders only visible + overscan items, measures dynamic heights, optional `onNearEnd` for infinite scroll. Used by long append-growth lists (favorites, submissions, collection videos).
- **Hooks:** `useLogin`, `useSettings`, `useTheme` (module-level `lastMode` global — be careful with multi-instance), `useDownloadEvents` (subscribes the 5 download events once; two-tier progress throttle + DB writes; owns the `downloadingIds` dedup set, cleaned up on terminal states), `useUrlIntake` (window-focus clipboard read + document drop → auto-fill B站 links into the controlled `DownloadInput`; dedup on extracted match).
- **Contexts:** `UpdateContext` (auto-update lifecycle; value memoized), `Toast`.
- **Types:** `src/types.ts` — `ParsedVideoInfo`, `VideoPage`, `ParsedItem`, `DownloadTask`, `formatDuration()`, plus `dbToParsedItem`/`dbToDownloadTask` mappers.
- **Styling:** Tailwind only; `cn()` from `lib/utils.ts`. Icons: `lucide-react`.

### Online Player (MSE, 在线播放)

Built-in streaming player (added v0.8.3+), fully independent of the download path (its own codec choice, its own seek, its own danmaku format). Reached from `VideoDetail` (`onPlay`) → `App.tsx` sets `playingItem` → `VideoPlayer.tsx` (full-screen overlay, re-mounted fresh each open).

- **Forced AVC/H.264 + AAC.** The webview's MSE supports `avc1`/`mp4a` most completely, so `get_play_streams` (`commands/player.rs`) **ignores** the user's `video_codec_priority` and requests `["AVC"]` only. Quality ceiling is uncapped (4K/8K if B站 serves AVC). The download path is unaffected and still honors `video_codec_priority`.
- **`biliproxy` custom URI scheme** — registered via `register_asynchronous_uri_scheme_protocol("biliproxy", …)` in `lib.rs`. Frontend `fetch("http://biliproxy.localhost/b/<base64url(B站 url)>")` → Rust re-fetches the B站 URL with `Referer`+`Cookie`, transparently proxies `Range`/`Content-Range`, and adds CORS/exposed headers. Solves two problems at once: the browser can't fetch B站's CDN directly (CORS), and B站 requires a `Referer`. A **pooled `PROXY_CLIENT`** (keep-alive `reqwest::Client`) is reused across all 2 MB chunks — the old per-chunk client meant a TCP+TLS handshake on every fetch and crippled startup/seek/quality-switch latency. This is a deliberate, documented exception to the per-function-client convention.
- **`proxy_fetch_bytes(url, start, end)`** (`lib.rs`, exposed as `crate::proxy_fetch_bytes`) — same pooled client, used by `mp4_seek.rs` to pull `moov`/`sidx` bytes **server-side**, bypassing the webview.
- **Precise seek via `sidx`** (`bilibili/mp4_seek.rs`). B站 DASH is fragmented fMP4 (`ftyp + moov + sidx + (moof+mdat)×N`). `get_seek_index` parses the `sidx` box into a `time→byte` index; on a seek to an unbuffered time, `VideoPlayer` rebuilds the `SourceBuffer`, appends the init segment (`[0, init_end)`), then fetches from the target fragment's moof byte. The moof carries its own absolute time (tfdt), so no `timestampOffset` remap is needed. Parse failure → `None`, frontend falls back to sequential fill. Player-only; the download path never uses it.
- **MSE lifecycle** (`VideoPlayer.tsx`): one `MediaSource` + separate video/audio `SourceBuffer`s, fed by 2 MB ranged fetches. Pacing follows each buffer's *own* `sb.buffered` (NOT `video.buffered` — that's the A/V intersection, and one slow stream would starve the other into over-fetching). Buffer window ~20 s ahead, evicts behind; on `QuotaExceeded`/`SourceBuffer is full`, forces eviction then retries the append once. Quality switch & multi-P switch re-run the same `play()` with a resume time ("catch-up" mode: fill to target then seek). A freeze-frame `<canvas>` overlay (continuously cached on `timeupdate`/`playing`) hides the black frame during `SourceBuffer` rebuilds — its `display` state is driven via ref, not JSX, so React re-renders don't wipe it.
- **Player commands** (`commands/player.rs`): `get_play_streams`, `get_danmaku_json` (raw JSON for the player's danmaku overlay — distinct from `danmaku.rs`'s protobuf→ASS download path), `get_subtitle_list` (all tracks **including AI subs** — the download path's `get_subtitle_urls` filters them out; player needs them since many videos have AI subs only), `get_subtitle_cues` (structured `{from,to,content}` cues for the overlay), `get_seek_index`, `log_player_error` (pipes webview errors into `app.log`, since the frontend console isn't file-logged).
- **Speed & subtitles** (`VideoPlayer.tsx`): top-bar 倍速 menu (0.5–2x; WebView2 native controls expose no speed control, so it's custom; rate is re-applied as `defaultPlaybackRate`+`playbackRate` after every `video.src` rebuild since src assignment resets it) and 字幕 menu + `pointer-events-none` bottom overlay driven by `timeupdate` cue scan. Subtitle selection survives quality switches (same cid) but resets on multi-P switch. `aid` is threaded to the player via the shared `PlayingItem` type (subtitle APIs require it).

### Tauri Events (Backend → Frontend)

| Event | Payload | Purpose |
|---|---|---|
| `download://progress` | `{ id, label, downloaded, total, percent, speed }` | Per-stream progress (`label` = "video"/"audio"; `speed` bytes/s from the shared `SpeedTracker`, 500ms min sampling); emitted every 512KB backend-side |
| `download://complete` | `{ id, output_path, size }` | Download finished (size from `fs::metadata`) |
| `download://error` | `{ id, error }` | Download failed (incl. risk control) |
| `download://state` | `{ id, status }` | status: `queued`/`downloading`/`paused`/`cancelled` (scheduler lifecycle). Pausing a **queued** (not-yet-started) task is detected by the command layer (`PauseOutcome::Pending`) — the dispatcher never sees it, so the `paused` event is emitted from `pause_download`/`pause_all_downloads` |
| `download://risk_control` | `{ v_voucher }` | Captcha required |

### Batch Download & Subscriptions (批量下载与订阅追更)

`commands/batch.rs` + `commands/subscription.rs`, sharing dedup logic in `db.rs`:

- **Batch download** — `batch_download_bvids(bvids, folder?)` / `batch_download_season(season_id)` resolve cids **server-side** (no per-video frontend `parse_video` round-trips), dedup against `download_history` via `build_download_dedup`, insert DB rows as `queued`, and submit to the download manager. 350ms pacing between per-video view lookups (风控). Frontend surfaces this via the shared `BatchBar` component (选择 → 全选 → 下载已选) on submissions / collections / favorites / watch-later / weekly lists.
- **Subscriptions** (`subscriptions` table, schema 102): `kind` = `season`/`series`/`favorite`. Adding captures the current bvid list as **baseline** — only items published *after* subscribing are auto-downloaded (fetch failure at add time → no insert, fail-closed against accidental mass-download). The scheduler spawned in `lib.rs` setup ticks every 60s and checks all subscriptions when `subscription_check_interval_min` > 0. `check_subscription` also runs on-demand from the Subscriptions tab.

### Registered Commands (84)

Grep `generate_handler![]` in `lib.rs` for the authoritative list.

- **Settings (7):** `get_settings`, `save_settings`, `patch_settings`, `get_gpu_presets`, `get_resolution_presets`, `generate_fingerprint_cmd`, `generate_random_fingerprint`.
- **Video/detail (3):** `parse_video`, `get_related_videos`, `get_ai_summary` (official AI conclusion API, WBI-signed; returns `Ok(None)` when B站 has no summary).
- **Download (5):** `download_video` (submit-only; also drives danmaku ASS + subtitle SRT + NFO as side artifacts), `pause_download`, `cancel_download`, `set_download_priority`, `pause_all_downloads`.
- **Batch (2):** `batch_download_bvids`, `batch_download_season`.
- **Login/captcha (6):** `login_generate_qrcode`, `login_poll_qrcode`, `login_check`, `login_logout`, `captcha_register`, `captcha_validate`.
- **Parse history (6):** `get_parse_history`, `get_parse_count`, `save_parse_history`, `delete_parse_history`, `clear_parse_history`, `touch_parse_history`.
- **Download history (7):** `get_download_history`, `get_download_count`, `get_download_stats`, `save_download_entry`, `update_download_status`, `delete_download_history`, `clear_download_history`.
- **Search (7):** `search_videos`, `get_hot_search`, `get_search_suggest`, `get_search_history`, `save_search_keyword`, `delete_search_keyword`, `clear_search_history`.
- **Lists (12):** favorites (`get_favorite_folders`, `get_favorite_videos`), watch-later (`get_watch_later`, `add_watch_later`, `remove_watch_later`), relations (`get_followings`, `get_followers`), upper (`get_upper_info`, `get_submission_videos`, `get_upper_collections`, `get_collection_videos`, `get_subscribed_collections`).
- **Discovery (10):** `get_ranking`, `get_pgc_rank`, `get_bangumi_follow`, `get_recommend`, `get_region`, `get_dynamic_feed`, `get_watch_history`, `get_weekly_series`, `get_weekly_detail`, `get_precious_list` (入站必刷).
- **Articles (2):** `get_article_content`, `export_article_markdown`.
- **Play progress (2):** `get_play_progress`, `save_play_progress`.
- **Interaction/comments (5):** `like_video`, `coin_video`, `favorite_video`, `get_video_comments` (mode 2/3 sort), `get_comment_replies` (楼中楼).
- **Player (6):** `get_play_streams` (forces AVC; returns all AVC qualities + audio URL), `get_danmaku_json` (raw JSON for player overlay), `get_subtitle_list` (all tracks incl. AI subs; needs bvid+cid+aid), `get_subtitle_cues` (subtitle JSON → `{from,to,content}` cues), `get_seek_index` (sidx time→byte index, player-only), `log_player_error` (webview error → `app.log`).
- **Subscriptions (4):** `get_subscriptions`, `add_subscription`, `remove_subscription`, `check_subscription`.

## Key Conventions

- **All B站 HTTP calls go through Rust** — no direct `fetch` from frontend.
- **Clipboard/drop link intake:** `tauri-plugin-clipboard-manager` (registered in `lib.rs`, `clipboard-manager:allow-read-text` in capabilities) powers `useUrlIntake`: on window focus it reads the clipboard and auto-fills the controlled `DownloadInput` with the first B站 link (dedup on the extracted match). Document-level `drop` does the same from any view. `tauri.conf.json` sets **`dragDropEnabled: false`** on the main window — Tauri 2's native drag-drop otherwise swallows DOM `drop` events (nothing in the app uses native file-drop).
- **Filename template:** `settings.filename_template` rendered by `bilibili/filename.rs` in `execute_download`; output path = `download_dir.join(format!("{rel}.{ext}"))` (never `with_extension` — it would mangle titles containing dots). All side artifacts (ASS/SRT/NFO/cover) derive from `output_path`'s stem, so they follow the template automatically. `{up}` needs `owner_name`, which flows: frontend submit → `download_video` param → DB `owner_name` column → resume/retry.
- **reqwest clients are created per-call** via the shared `api_client()` / `download_client()` factories in `bilibili/mod.rs`, with `cookie_store(false)` to avoid cookie-jar contamination. This is deliberate — no long-lived shared client (the one documented exception is the pooled `PROXY_CLIENT` for `biliproxy`). `favorite.rs`/`passport.rs` still carry local duplicate `bilibili_client()` builders pending consolidation. Where one client serves a whole flow (a video's danmaku+subtitle+NFO), it's threaded through rather than rebuilt per call.
- **Concurrency — two layers of Semaphores**, both from `AppSettings`:
  - Global `DOWNLOAD_SEMAPHORE` (`max_concurrent_downloads`) — acquired by the dispatcher via `acquire_owned`, **the permit is moved into the spawned task and held until it finishes** (rebuilt only when capacity changes).
  - Per-video `VIDEO_SEMAPHORES` map (`max_pages_per_video`) — acquired in `execute_download`; **keyed by `video_semaphore_key` = `video_title` (prefixed `t:`) so a whole bangumi season (each episode has its own bvid) shares one bucket, falling back to `bvid` when `video_title` is empty**; **cleanup uses `Arc::strong_count <= 2`** (map + current caller = no other task using), NOT `available_permits()` (that never matched because the caller still held its permit — the old impl leaked the map forever).
  - Parallel Range download uses `parallel_threads` per stream.
- **Download scheduler** is a background task independent of the window lifecycle — hiding the window (close-to-tray) does **not** stop downloads; only window close (when `close_to_tray=false`) or tray "退出" exits.
- **Cookie auto-refresh** runs on `login_check()` and download -101 errors via `Credential::check_and_refresh()`.
- **Risk control flow:** playurl returns `v_voucher` → emit `download://risk_control` → frontend `CaptchaDialog` → `captcha_register`+`captcha_validate` → `gaia_vtoken` cached 1h.
- **WBI signing:** all playurl/search/submission/collection requests use `wbi::sign_params()`; the mixin key is cached **with a 12h TTL** (B站 rotates keys daily) and refreshed on HTTP 412 / API -404. A fetch-lock serializes cold-start fetches to avoid stampeding `/nav`.
- **Resume/fingerprint:** `.meta` first line is a stream fingerprint; mismatch (stream change) discards the old file. Parallel resume uses a per-segment completion bitmap, **flushed every 8 segments + on interrupt** (the failure path re-flushes from the in-memory bitmap so the persisted bitmap matches what's actually on disk).
- **History DB:** all history commands take `State<'_, DbState>` and acquire the connection mutex — **never hold it across `.await`**.
- **Frontend progress throttling:** the `download://progress` listener (in the `useDownloadEvents` hook) gates `setDownloads` and the DB write behind **two separate per-id throttles** — UI at `DOWNLOAD_PROGRESS_THROTTLE_MS` (1.2 s), DB writes at the sparser `DOWNLOAD_DB_WRITE_MS` (5 s, mid-progress is only needed for restart-recovery display). Complete/error/state listeners update and persist immediately. All listeners clean up via a `cancelled` flag + `unlisteners`.
- **Long lists are virtualized** (`VirtualList`) — favorites, submissions, collection videos use it (windowed render + infinite scroll). Paginated history lists (20/page) and bounded lists (recommend ~20, ranking ~100) are **not** virtualized. `CommentSection` is not yet virtualized (needs a fixed-height scroll container in `VideoDetail`).
- **CSP** in `tauri.conf.json` is an explicit allowlist (v0.8.8 tightened it from the old `connect-src *`): `img-src * data: blob:` for avatar/cover images; `media-src 'self' blob: data:` and `connect-src 'self' ipc: http://ipc.localhost biliproxy: http://biliproxy.localhost https://*.geetest.com` — `blob:` for the MSE object URLs, the two `biliproxy` forms so the webview may `fetch()` the proxy scheme, `ipc:`/`http://ipc.localhost` for Tauri invoke, geetest for the captcha SDK. `script-src` explicitly allows `https://*.geetest.com`. Breaking the player entries (v0.8.4 regression) silently kills playback.
- **localStorage** prefix for update state: `bilibili_dl:`.
- **GeeTest v3 SDK** loaded via `<script>` in `index.html` from `https://static.geetest.com/v3/gt.js`.
- **Logging:** `init_logger()` writes INFO to `app.log` next to exe (LineWriter = per-line flush), WARN to console. DEBUG is intentionally not file-logged (per-segment/per-progress logging would bloat it).
- **Error classification** in the download path is currently string-prefix based (`is_interrupted`/`is_login_expired`/`extract_risk_control` match `"DOWNLOAD_INTERRUPTED:"`/`"-101"`/`"RISK_CONTROL:"` on the stringified error). Fragile — prefer a typed error enum if extending.

## Shared Types (Frontend ↔ Rust)

Rust serde enums/structs serialize to JSON consumed by TypeScript. Enums use `#[serde(rename_all = "snake_case")]`. Key types: `AppSettings` (quality ranges, codec priority, concurrency, danmaku render opts, NFO opts, 风控 fingerprint `dm_img_*`, theme, tray/notify flags, `filename_template`), `UserInfo`, `QrPollResult`, `Credential`, `VideoInfo` (with `extra_pages`, `ep_id`, stats), `PageInfo` (with `bvid`, `ep_id`), `ParsedUrl`, `CaptchaInfo`, `FavoriteFolder`/`FavoriteMedia`, `ParseHistoryEntry`/`DownloadHistoryEntry` (with `owner_name` since v6), `VideoListItem`/`PagedResult<T>` (shared list shape for browse APIs), `PlayingItem` (frontend-only shared payload: VideoDetail onPlay → App state → VideoPlayer; carries `aid` for subtitle APIs).
