# AGENTS.md

## What this is

Tauri 2 desktop app (Windows-only) for downloading Bilibili videos. Rust backend + React 18 frontend (Vite + Tailwind CSS). Single-package repo, not a monorepo.

## Commands

```bash
pnpm dev                        # Full Tauri dev (starts Vite + compiles Rust)
pnpm build                      # Production build
pnpm typecheck                  # TypeScript only (tsc --noEmit)
cd src-tauri && cargo check     # Rust only
cd src-tauri && cargo test --lib  # Rust unit tests DO exist (db.rs / download_manager.rs / download.rs, ~70 tests)
```

There is **no linter or formatter** configured (`eslint` / `prettier` / `vitest` don't exist), but `cargo test --lib` works and should stay green.

## Architecture quirks an agent will trip on

- **Project directory is `D:\work\bilbili_copy`** (b-i-l-b-i-l-i). Note the spelling — it differs by one letter from the crate name typo below; double-check paths before file operations.
- **Vite root is `src/`**, not the project root. `index.html` lives in `src/index.html`. Build output goes to `dist/` at project root.
- **Path alias**: `@/*` → `./src/*` (both in tsconfig and vite).
- **Crate name typo**: The Rust lib crate is `bilbli_copy_lib` (missing 'i'). `main.rs` calls `bilbli_copy_lib::run()`. Don't "fix" this — it matches `Cargo.toml`.
- **SQLite via rusqlite**: Database state (`DbState`) is Tauri-managed. Schema lives inline in `db.rs` (schema_version + incremental migrations; current version 102). DB file (`data.db`) stored next to exe, uses WAL mode.
- **HTTP clients**: shared `api_client()` pool in `bilibili/mod.rs` for short API calls; `bilibili/client.rs` exists but is unused. Cookie jar is intentionally off — cookies attached per request.
- **All Bilibili HTTP calls go through Rust**. Frontend never fetches Bilibili APIs directly — it calls `invoke()` to reach Tauri commands. JS args are camelCase, Rust params snake_case (Tauri converts automatically).
- **Data files next to exe**: `settings.json`, `credentials.json`, `app.log`, `data.db`. Atomic writes (tmp+rename) for JSON files.
- **System proxy**: On Windows, reads proxy from registry at startup in `init_system_proxy()`.

## Tauri commands (84 total)

Registered in `lib.rs` via `generate_handler![]` (grep it for the authoritative list):

- Settings: `get_settings`, `save_settings`, `patch_settings`, fingerprint presets/generation
- Video/detail: `parse_video`, `get_related_videos`, `get_ai_summary`
- Download: `download_video`, `pause_download`, `pause_all_downloads`, `cancel_download`, `set_download_priority`, `batch_download_bvids`, `batch_download_season`
- Login/captcha: `login_generate_qrcode`, `login_poll_qrcode`, `login_check`, `login_logout`, `captcha_register`, `captcha_validate`
- History DB: parse history CRUD (`get/save/delete/touch/clear/count`), download history CRUD + `get_download_stats`, play progress (`get/save_play_progress`)
- Search: `search_videos`, `get_hot_search`, `get_search_suggest`, search-history CRUD
- Lists: favorites (`get_favorite_folders`, `get_favorite_videos`), `get_watch_later`, `add_watch_later`, `remove_watch_later`, `get_followings`, `get_followers`, submissions/collections (`get_upper_info`, `get_submission_videos`, `get_upper_collections`, `get_collection_videos`, `get_subscribed_collections`)
- Discovery: `get_ranking`, `get_pgc_rank`, `get_bangumi_follow`, `get_recommend`, `get_region`, `get_weekly_series`, `get_weekly_detail`, `get_precious_list`, `get_dynamic_feed`, `get_watch_history`
- Interaction/comments: `like_video`, `coin_video`, `favorite_video`, `get_video_comments`, `get_comment_replies`
- Player: `get_play_streams`, `get_danmaku_json`, `get_subtitle_list`, `get_subtitle_cues`, `get_seek_index`, `log_player_error`
- Articles: `get_article_content`, `export_article_markdown`
- Subscriptions (追更): `get_subscriptions`, `add_subscription`, `remove_subscription`, `check_subscription`

## Batch download & subscriptions (commands/batch.rs, commands/subscription.rs)

- `batch_download_bvids(bvids, folder?)` / `batch_download_season(season_id)` resolve cids server-side, dedup against `download_history` (done/queued/downloading/paused skipped; error rows reuse their id via INSERT OR REPLACE), insert DB rows as `queued`, and submit to the download manager. 350ms pacing between per-video view lookups.
- Subscriptions (`subscriptions` table, schema 102): `kind` = `season`/`series`/`favorite`. Adding captures the current bvid list as baseline (only NEW items are auto-downloaded). A scheduler spawned in `lib.rs` setup ticks every 60s and checks all subscriptions when `settings.subscription_check_interval_min` > 0 (0 = off, default).

## Version management

Version must be synced in **three files** before release:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package].version`
- `src-tauri/tauri.conf.json` → `"version"`

Only change version when explicitly asked. CI triggers on `v*` tag push. Tag push: `git push origin v0.X.X` (single tag, not `--tags`).

**Release flow**: batch all changes → write `RELEASE_NOTES.md` (CI reads it as release body) → single commit → tag.

## CSP and external resources

`tauri.conf.json` CSP allows `connect-src *` and `img-src * data: blob:`. GeeTest v3 SDK loaded via `<script>` in `index.html` from `https://static.geetest.com/v3/gt.js`.

## Key Tauri events (backend → frontend)

`download://progress` (includes `speed` bytes/s), `download://complete`, `download://error`, `download://risk_control`, `download://state` (queued/downloading/paused/cancelled; pause of a *queued* task is emitted by the command layer since the dispatcher never sees it).

## Serde conventions

Rust types serialize to JSON consumed by TypeScript. Enums use `#[serde(rename_all = "snake_case")]`.

## Existing instruction files

- `CLAUDE.md` — detailed architecture reference. Some sections are stale (command count, missing db.rs and history commands). Use for module-level detail but verify against source.
