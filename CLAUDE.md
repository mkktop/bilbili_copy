# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
pnpm dev              # Start Tauri dev (Rust + Vite frontend)
pnpm build            # Production build
pnpm typecheck        # TypeScript check (frontend only)
cd src-tauri && cargo check  # Rust compilation check
```

## Version Management

Version must be synced in **three files** before release:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package].version`
- `src-tauri/tauri.conf.json` → `"version"`

Only change version when explicitly asked. CI triggers on `v*` tag push.

**Release flow: batch all changes, then tag once.** Code fixes + version sync must be in a single commit. Only create the tag after confirming everything is ready. Never push multiple tags for the same version — each tag push triggers CI and forces users to update.

**Release notes: write `RELEASE_NOTES.md` before tagging.** CI reads this file as the GitHub Release body and as the in-app update changelog. Every time a tag is created, write `RELEASE_NOTES.md` with the actual changes since the last version (features, fixes, improvements). Format: markdown with `## 更新内容` section listing bullet points, followed by install/upgrade instructions. Commit it together with the version bump before tagging.

**Tag push:** use `git push origin v0.X.X` (single tag), not `--tags` (pushes all local tags).

## Architecture

Tauri 2 desktop app: Rust backend + React 18 frontend (Vite + Tailwind CSS).

### Backend (`src-tauri/src/`)

Two module layers:
- **`commands/`** — `#[tauri::command]` handlers, parameter validation, orchestration. Registered in `lib.rs` via `generate_handler![]`.
- **`bilibili/`** — Core business logic, organized by B站 API domain:
  - `passport.rs` — QR login flow (seed buvid → generate QR → poll → extract cookies → validate). Includes `fetch_buvid()` SPI fallback.
  - `credential.rs` — `Credential` struct with file persistence (`credentials.json`), cookie header builder, and **Cookie auto-refresh** (RSA encryption → CSRF extraction → 3-step refresh → confirm). Uses `rsa`, `sha2`, `hex`, `rand` crates.
  - `url.rs` — URL parser: extracts bvid/aid/ep_id/season_id/media_id/page from all URL formats, b23.tv short link resolution, Base58 bvid↔aid conversion.
  - `wbi.rs` — WBI signature: `sign_params()` with MD5 mixin key, cached via `OnceLock<RwLock<>>`, auto-refresh on 412/-404.
  - `video.rs` — `get_video_info()`: resolves BV/AV/ep/season/media URLs, bangumi season API fallback, `-404` redirect to bangumi, separates main episodes from previews via `badge_type`, returns `VideoInfo` with stats.
  - `playurl.rs` — Stream URL resolution: quality fallback chain (8K→360P), codec priority (AVC/HEVC/AV1), bangumi API fallback, FLAC/Dolby audio, `v_voucher` risk control detection, WBI-signed requests.
  - `download.rs` — Download engine: parallel Range-based downloading, single-thread resume, bad CDN caching (10-min TTL), multi-URL fallback, ffmpeg merge/remux, progress events.
  - `risk_control.rs` — GeeTest v3 captcha: register/validate APIs, `gaia_vtoken` in-memory cache (1-hour TTL).
  - `client.rs` — Skeleton wrapper (unused; other modules create their own reqwest clients).

Shared in `mod.rs`: `USER_AGENT`, `REFERER`, `ORIGIN`, `BilibiliResponse<T>`, `http_to_https()`.

Data files stored next to exe: `settings.json`, `credentials.json`, `app.log`.

### Frontend (`src/`)

- **Views:** `App.tsx` toggles between `"main"`, `"settings"`, `"detail"`, `"downloads"` via state (no router).
- **Components:** `DownloadInput`, `ParseList`, `VideoDetail` (main/extra tabs + sort toggle), `DownloadList`, `SettingsPage` (General/Quality/Download/About tabs), `LoginDialog`, `CaptchaDialog` (GeeTest v3), `UserProfile`.
- **Hooks:** `useLogin`, `useSettings` — call `invoke()` to reach Rust commands.
- **Contexts:** `UpdateContext` — auto-update lifecycle (check/download/install).
- **Types:** `src/types.ts` — `ParsedVideoInfo`, `VideoPage`, `ParsedItem`, `DownloadTask`, `formatDuration()`.
- **Styling:** Tailwind utility classes only, `cn()` from `lib/utils.ts` for conditional merging.
- **Icons:** `lucide-react`.

### Tauri Events (Backend → Frontend)

| Event | Payload | Purpose |
|---|---|---|
| `download://progress` | `{ id, percent }` | Download progress |
| `download://complete` | `{ id, output_path }` | Download finished |
| `download://error` | `{ id, error }` | Download failed |
| `download://risk_control` | `{ v_voucher }` | Captcha required |

### Registered Commands (10)

`get_settings`, `save_settings`, `parse_video`, `download_video`, `login_generate_qrcode`, `login_poll_qrcode`, `login_check`, `login_logout`, `captcha_register`, `captcha_validate`.

## Key Conventions

- All B站 HTTP calls go through Rust backend (no direct fetch from frontend).
- `reqwest` clients are created per-function (not shared) to avoid cookie jar contamination.
- CSP in `tauri.conf.json` must include B站 CDN domains (`*.hdslb.com`, `*.bilibili.com`) for avatar images.
- localStorage prefix for update state: `bilibili_dl:`.
- System proxy detection reads Windows registry on startup (`init_system_proxy()` in `lib.rs`).
- GeeTest v3 SDK loaded via `<script>` in `index.html` from `https://static.geetest.com/v3/gt.js`.
- **Cookie auto-refresh** called on `login_check()` and download -101 errors via `Credential::check_and_refresh()`.
- **Risk control flow**: playurl returns `v_voucher` → emit `download://risk_control` → frontend `CaptchaDialog` → `captcha_register` + `captcha_validate` → `gaia_vtoken` cached 1 hour.
- **Download concurrency**: global `Semaphore` (`max_concurrent_downloads`) + per-video `Semaphore` (`max_pages_per_video`), both from `AppSettings`.
- **Parallel download**: files >4MB use Range-based parallel download (`parallel_threads`); falls back to single-thread.
- **ffmpeg**: resolved from exe directory or resources subdirectory; DASH merge and FLV remux.
- **Bangumi episode separation**: `badge_type=1` → preview (extra), `badge_type=0` → main episode. `result.section` content also merged into extras.
- **Logging**: `init_logger()` writes DEBUG to `app.log` next to exe, WARN to console.
- **Atomic file writes**: `credentials.json` and `settings.json` use tmp+rename.
- **WBI signing**: all playurl requests use `wbi::sign_params()`, auto-refresh mixin key on HTTP 412 or API -404.

## Shared Types (Frontend ↔ Rust)

Rust serde enums/structs serialize to JSON consumed by TypeScript hooks. Enums use `#[serde(rename_all = "snake_case")]`. Key types: `AppSettings` (quality ranges, codec priority, concurrency), `UserInfo`, `QrPollResult`, `Credential`, `VideoInfo` (with `extra_pages`, `ep_id`, `view_count`, `danmaku_count`), `PageInfo` (with `bvid`, `ep_id`), `ParsedUrl`, `CaptchaInfo`.

## Not Yet Implemented

- `bilibili/client.rs` — Shared client wrapper exists but unused; modules create their own reqwest clients.
