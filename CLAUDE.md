# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
pnpm dev              # Start Tauri dev (Rust + Vite frontend)
pnpm build            # Production build (Tauri bundle)
pnpm typecheck        # TypeScript check (frontend only) — primary frontend gate
pnpm build:renderer   # Vite build only (frontend bundle, no Rust)
cd src-tauri && cargo check     # Rust compilation check — primary backend gate
cd src-tauri && cargo test      # Rust unit tests (download_manager scheduler, db migrations)
```

No separate lint step. `pnpm typecheck` + `cargo check` are the correctness gates before building. `cargo test` exists (scheduler priority/FIFO tests, db migration tests) but is **not** in CI — run it manually when touching `download_manager.rs` or `db.rs` migrations.

## Version Management

Version must be synced in **three files** before release:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package].version`
- `src-tauri/tauri.conf.json` → `"version"`

Only change version when explicitly asked. CI triggers on `v*` tag push.

**Release flow: batch all changes, then tag once.** Code fixes + version sync must be in a single commit. Only create the tag after confirming everything is ready. Never push multiple tags for the same version — each tag push triggers CI and forces users to update.

**Release notes: write `RELEASE_NOTES.md` before tagging.** CI reads this file as the GitHub Release body and the in-app update changelog. Prepend a new `## vX.X.X 更新内容` section (keep history below, separated by `---`). Commit it together with the version bump before tagging.

**Tag push:** use `git push origin v0.X.X` (single tag), not `--tags`. If master has diverged from remote after pushing the tag, **merge** remote (`git merge origin/master`) rather than rebase — rebase moves the already-pushed tagged commit and would require re-pushing the tag (forbidden: re-triggers CI).

## Architecture

Tauri 2 desktop app: Rust backend + React 18 frontend (Vite + Tailwind CSS). A Bilibili video downloader: parse URLs → resolve streams → parallel download → ffmpeg merge, with QR login, danmaku/subtitle/NFO side artifacts, and风控 (risk-control) captcha handling.

### Backend (`src-tauri/src/`) — four top-level layers

1. **`lib.rs`** — app setup: logger init (`init_logger`, `app.log` next to exe), system proxy detection (`init_system_proxy()`, reads Windows registry → sets `HTTPS_PROXY` so the updater can use it), SQLite `init_db()` as managed state, system tray (close-to-tray intercept via `on_window_event`), and the single `generate_handler![]` registering **all** commands. The download scheduler dispatcher is spawned here in `setup`. Also hosts the **`biliproxy` custom URI-scheme protocol** + pooled `PROXY_CLIENT` + `proxy_fetch_bytes()` for the online player (see [Online Player](#online-player-mse-在线播放)).

2. **`download_manager.rs`** — **Download scheduler** (decouples submit from execute). `manager()` is a global singleton (`Lazy`). Flow:
   - `download_video` command only **validates + submits** a task to the priority queue, returns immediately.
   - `run_dispatcher` (spawned once in `setup`) loops: `pop_highest` (priority desc, seq asc = FIFO) → check cancel → acquire global permit → re-check cancel → register in `running` → `spawn execute_download`.
   - Runtime **pause/cancel** via `CancellationToken` + `TargetState` (Running/Pausing/Cancelling) — determines whether `.tmp` is kept (pause) or cleaned (cancel) and which event is emitted.
   - **Priority adjustment** (`set_download_priority`) only affects queued (not-yet-started) tasks.
   - Lock poisoning is recovered everywhere (`unwrap_or_else(|p| p.into_inner())`) so one panic never permanently wedges scheduling.

3. **`db.rs`** — SQLite persistence (`rusqlite`) via `DbState(Mutex<Connection>)`. Tables: `parse_history`, `download_history`, `download_stats` (cumulative counters), `schema_version`. **Schema is at v5** (incremental migration in `migrate_schema`, idempotent via `column_exists` guards; v5 backfills `download_stats` from existing `done` rows). On startup, any `downloading` rows are reset to `paused` (orphan cleanup for abnormal exits → user can resume, reusing `.tmp`). WAL + foreign_keys on.

4. **`commands/`** (20 submodules) — `#[tauri::command]` handlers grouped by domain. The **validation/orchestration** layer; each re-exports commands for `generate_handler![]`. `commands/download.rs` holds `execute_download` (the real download pipeline, called by the dispatcher) + the dynamic concurrency limiters; `commands/player.rs` holds the online-player stream/seek/danmaku commands (independent of the download path).

5. **`bilibili/`** (28 submodules) — core business logic, organized by B站 API domain:
   - **Download pipeline:** `url.rs` (parse bvid/aid/ep/season/media + b23 short-link resolution) → `video.rs` (`get_video_info`, bangumi fallback, main/preview split via `badge_type`) → `playurl.rs` (stream resolution) → `download.rs` (engine).
   - **Online player:** `playurl.rs` (shared with downloads — exposes `all_qualities` for the quality menu), `mp4_seek.rs` (`sidx` box parser → time/byte index for precise seek; player-only, see [Online Player](#online-player-mse-在线播放)), `danmaku.rs` (`fetch_danmaku_list` returns raw JSON for the player's overlay, distinct from its protobuf→ASS path used for downloads), `interaction.rs` (like/coin/favorite POSTs; shared `interaction_post` helper injects csrf in form+cookie, detects `v_voucher` risk, **no auto-retry** on risk — unlike the download path).
   - **`download.rs`** — the engine: parallel Range-based downloading (>4MB → `parallel_threads` Range segments, else single-thread resume), **BufWriter** on all file writes, `.meta` resume bitmap (fingerprint-validated, **flush debounced** to every 8 segments + on interrupt), bad-CDN cache (10-min TTL, multi-URL fallback), `throttle.rs` global byte-rate limiter, ffmpeg merge/remux. Progress emitted every 512KB.
   - **`playurl.rs`** — **single-request fast path**: one `qn=max` request (fnval=4048 returns all qualities in `dash.video`) → `parse_streams` picks best in `[min_qn,max_qn]` with codec priority; per-quality fallback loop only runs if the single request fails. The returned `Streams` also carries `all_qualities` (every resolved quality+codec, not just the picked best) — the online player surfaces all AVC entries as its quality menu. WBI-signed.
   - **Auth/cred:** `passport.rs` (QR login: seed buvid → QR → poll → cookies → validate; `validate_credentials` runs nav + relation **in parallel**), `credential.rs` (`Credential` struct, file persistence, cookie header, **auto-refresh** via RSA→CSRF→3-step→confirm), `wbi.rs` (WBI signature, **mixin key cached with 12h TTL** + fetch-lock to prevent cold-start stampede; auto-refresh on 412/-404).
   - **Side artifacts:** `danmaku.rs` (protobuf → ASS, collision/scroll layout), `subtitle.rs` (player v2 → SRT, AI-sub detection), `nfo.rs` (.nfo + cover thumb/fanart).
   - **Browse/explore** (uniform pattern — call API, parse JSON `Value`, return typed list): `favorite.rs`, `search.rs`, `submission.rs`, `collection.rs`, `following.rs`, `history.rs`, `ranking.rs`, `pgc.rs`, `recommend.rs`, `region.rs`, `comment.rs`, `watch_later.rs`.
   - **Risk control:** `risk_control.rs` (GeeTest v3, `gaia_vtoken` in-memory 1h cache), `fingerprint.rs` (browser/GPU fingerprint generation), `throttle.rs` (download byte-rate limiter — **download-only**, no global API rate limiter).

   Shared in `bilibili/mod.rs`: `USER_AGENT`, `REFERER`, `ORIGIN`, `API_TIMEOUT` (15s), `BilibiliResponse<T>`, `api_client()` (per-call client, `cookie_store(false)`, timeout), `VideoListItem`, `PagedResult`, `http_to_https()`.

Data files next to exe: `settings.json`, `credentials.json`, `data.db`, `app.log` (atomic tmp+rename for settings/credentials).

### Frontend (`src/`)

- **`App.tsx`** — single ~900-line component, **no router**; toggles views via `currentView` state (`"main" | "settings" | "detail" | "downloads" | "stats" | "profile" | "explore" | "ranking" | "recommend" | "region"`), rendered as an early-return ladder. Holds top-level state (downloads, parsedItems, pagination) and **all download-event orchestration** in one `useEffect` (see Conventions). The online player is a **separate** full-screen overlay, not a `currentView`: `VideoDetail.onPlay` sets a `playingItem` object → `VideoPlayer` mounts/unmounts on top of everything.
- **Components:** `DownloadInput`, `ParseList`, `VideoDetail`, `DownloadList` (rows are `React.memo` with a custom comparator keyed on item fields), `SettingsPage` (renders `settings/` tabs: General/Quality/Download/**Subtitle (字幕弹幕)**/AntiRisk/About), `LoginDialog`, `CaptchaDialog`, `UserProfilePage` (renders `tabs/`: WatchLater/WatchHistory/Subscriptions/Followings/UpperView), explore pages (`ExplorePage`/`RankingPage`/`RecommendPage`/`RegionPage`), `CommentSection`, `StatsPanel`, `VideoPlayer` (MSE online player — see [Online Player](#online-player-mse-在线播放)).
- **`VirtualList.tsx`** — reusable windowed list (`@tanstack/react-virtual`): takes a `scrollRef` to the outer `overflow-auto` container, renders only visible + overscan items, measures dynamic heights, optional `onNearEnd` for infinite scroll. Used by long append-growth lists (favorites, submissions, collection videos).
- **Hooks:** `useLogin`, `useSettings`, `useTheme` (module-level `lastMode` global — be careful with multi-instance).
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
- **Player commands** (`commands/player.rs`): `get_play_streams`, `get_danmaku_json` (raw JSON for the player's danmaku overlay — distinct from `danmaku.rs`'s protobuf→ASS download path), `get_seek_index`, `log_player_error` (pipes webview errors into `app.log`, since the frontend console isn't file-logged).

### Tauri Events (Backend → Frontend)

| Event | Payload | Purpose |
|---|---|---|
| `download://progress` | `{ id, label, downloaded, total, percent }` | Per-stream progress (`label` = "video"/"audio"); emitted every 512KB backend-side |
| `download://complete` | `{ id, output_path, size }` | Download finished (size from `fs::metadata`) |
| `download://error` | `{ id, error }` | Download failed (incl. risk control) |
| `download://state` | `{ id, status }` | status: `downloading`/`paused`/`cancelled` (scheduler lifecycle) |
| `download://risk_control` | `{ v_voucher }` | Captcha required |

### Registered Commands (53)

- **Settings (6):** `get_settings`, `save_settings`, `get_gpu_presets`, `get_resolution_presets`, `generate_fingerprint_cmd`, `generate_random_fingerprint`.
- **Video (1):** `parse_video`.
- **Download (4):** `download_video` (submit-only; also drives danmaku ASS + subtitle SRT + NFO as side artifacts), `pause_download`, `cancel_download`, `set_download_priority`.
- **Login (4):** `login_generate_qrcode`, `login_poll_qrcode`, `login_check`, `login_logout`.
- **Captcha (2):** `captcha_register`, `captcha_validate`.
- **Parse history (6):** `get_parse_history`, `get_parse_count`, `save_parse_history`, `delete_parse_history`, `clear_parse_history`, `touch_parse_history`.
- **Download history (7):** `get_download_history`, `get_download_count`, `get_download_stats`, `save_download_entry`, `update_download_status`, `delete_download_history`, `clear_download_history`.
- **Favorites (2):** `get_favorite_folders`, `get_favorite_videos`.
- **Browse/explore (13):** `get_watch_later`, `search_videos`, `get_upper_info`, `get_submission_videos`, `get_upper_collections`, `get_collection_videos`, `get_subscribed_collections`, `get_followings`, `get_watch_history`, `get_ranking`, `get_pgc_rank`, `get_recommend`, `get_region`.
- **Comment (1):** `get_video_comments`.
- **Interaction (3):** `like_video`, `coin_video`, `favorite_video`.
- **Player (4):** `get_play_streams` (forces AVC; returns all AVC qualities + audio URL), `get_danmaku_json` (raw JSON for player overlay), `get_seek_index` (sidx time→byte index, player-only), `log_player_error` (webview error → `app.log`).

## Key Conventions

- **All B站 HTTP calls go through Rust** — no direct `fetch` from frontend.
- **reqwest clients are created per-function** (`api_client()` / `download_client()`) with `cookie_store(false)` to avoid cookie-jar contamination. This is deliberate (`bilibili/client.rs` is an unused shared-client skeleton, intentionally not wired up). Where one client serves a whole flow (a video's danmaku+subtitle+NFO), it's threaded through rather than rebuilt per call.
- **Concurrency — two layers of Semaphores**, both from `AppSettings`:
  - Global `DOWNLOAD_SEMAPHORE` (`max_concurrent_downloads`) — acquired by the dispatcher, rebuilt only when capacity changes.
  - Per-video `VIDEO_SEMAPHORES` map (`max_pages_per_video`) — acquired in `execute_download`; **cleanup uses `Arc::strong_count <= 2`** (map + current caller = no other task using), NOT `available_permits()` (that never matched because the caller still held its permit — the old impl leaked the map forever).
  - Parallel Range download uses `parallel_threads` per stream.
- **Download scheduler** is a background task independent of the window lifecycle — hiding the window (close-to-tray) does **not** stop downloads; only window close (when `close_to_tray=false`) or tray "退出" exits.
- **Cookie auto-refresh** runs on `login_check()` and download -101 errors via `Credential::check_and_refresh()`.
- **Risk control flow:** playurl returns `v_voucher` → emit `download://risk_control` → frontend `CaptchaDialog` → `captcha_register`+`captcha_validate` → `gaia_vtoken` cached 1h.
- **WBI signing:** all playurl/search/submission/collection requests use `wbi::sign_params()`; the mixin key is cached **with a 12h TTL** (B站 rotates keys daily) and refreshed on HTTP 412 / API -404. A fetch-lock serializes cold-start fetches to avoid stampeding `/nav`.
- **Resume/fingerprint:** `.meta` first line is a stream fingerprint; mismatch (stream change) discards the old file. Parallel resume uses a per-segment completion bitmap, **flushed every 8 segments + on interrupt** (the failure path re-flushes from the in-memory bitmap so the persisted bitmap matches what's actually on disk).
- **History DB:** all history commands take `State<'_, DbState>` and acquire the connection mutex — **never hold it across `.await`**.
- **Frontend progress throttling:** the `download://progress` listener in `App.tsx` gates **both** `setDownloads` and the DB write behind the same per-id throttle (`DOWNLOAD_PROGRESS_THROTTLE_MS`), so the whole app isn't re-rendered on every progress tick. Complete/error/state listeners update immediately. All listeners clean up via a `cancelled` flag + `unlisteners`.
- **Long lists are virtualized** (`VirtualList`) — favorites, submissions, collection videos use it (windowed render + infinite scroll). Paginated history lists (20/page) and bounded lists (recommend ~20, ranking ~100) are **not** virtualized. `CommentSection` is not yet virtualized (needs a fixed-height scroll container in `VideoDetail`).
- **CSP** in `tauri.conf.json`: `img-src` includes B站 CDN domains + `data:`/`blob:` for avatar/cover images; `media-src 'self' blob: data:` and `connect-src * biliproxy:` are **required for the online player** — `blob:` for the MSE object URLs, `biliproxy:` so the webview may `fetch()` the proxy scheme. Breaking either (v0.8.4 regression) silently kills playback.
- **localStorage** prefix for update state: `bilibili_dl:`.
- **GeeTest v3 SDK** loaded via `<script>` in `index.html` from `https://static.geetest.com/v3/gt.js`.
- **Logging:** `init_logger()` writes INFO to `app.log` next to exe (LineWriter = per-line flush), WARN to console. DEBUG is intentionally not file-logged (per-segment/per-progress logging would bloat it).
- **Error classification** in the download path is currently string-prefix based (`is_interrupted`/`is_login_expired`/`extract_risk_control` match `"DOWNLOAD_INTERRUPTED:"`/`"-101"`/`"RISK_CONTROL:"` on the stringified error). Fragile — prefer a typed error enum if extending.

## Shared Types (Frontend ↔ Rust)

Rust serde enums/structs serialize to JSON consumed by TypeScript. Enums use `#[serde(rename_all = "snake_case")]`. Key types: `AppSettings` (quality ranges, codec priority, concurrency, danmaku render opts, NFO opts, 风控 fingerprint `dm_img_*`, theme, tray/notify flags), `UserInfo`, `QrPollResult`, `Credential`, `VideoInfo` (with `extra_pages`, `ep_id`, stats), `PageInfo` (with `bvid`, `ep_id`), `ParsedUrl`, `CaptchaInfo`, `FavoriteFolder`/`FavoriteMedia`, `ParseHistoryEntry`/`DownloadHistoryEntry`, `VideoListItem`/`PagedResult<T>` (shared list shape for browse APIs).
