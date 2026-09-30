# AGENTS.md

## What this is

Tauri 2 desktop app (Windows-only) for downloading Bilibili videos. Brand name **未雨 (Weiyu)** — renamed from "BilbliCopy" in v1.4.1: user-facing UI strings say 未雨, binary/installer/product name is `Weiyu`, Rust package `weiyu`. Rust backend + React 18 frontend (Vite + Tailwind CSS). Single-package repo, not a monorepo.

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

- **Project directory is `D:\work\bilbili_copy`** (b-i-l-b-i-l-i) — the repo/workspace folder still uses the pre-rename spelling and was NOT renamed. Double-check paths before file operations (plain MSYS-style `/d/...` cd sometimes fails here; use `cd "D:/..."` or relative paths).
- **Vite root is `src/`**, not the project root. `index.html` lives in `src/index.html`. Build output goes to `dist/` at project root.
- **Path alias**: `@/*` → `./src/*` (both in tsconfig and vite).
- **Crate name**: Rust package is `weiyu`, lib crate `weiyu_lib` (renamed from `bilbli-copy`/`bilbli_copy_lib` in the v1.4.1 rebrand). `main.rs` calls `weiyu_lib::run()`. Dev binary = `weiyu.exe` (cargo package name); installed exe/MSI = `Weiyu.exe` (tauri `productName`).
- **SQLite via rusqlite**: Database state (`DbState`) is Tauri-managed. Schema lives inline in `db.rs` (schema_version + incremental migrations; current version 102). DB file (`data.db`) stored next to exe, uses WAL mode.
- **HTTP clients**: shared `api_client()` pool in `bilibili/mod.rs` for short API calls; `bilibili/client.rs` exists but is unused. Cookie jar is intentionally off — cookies attached per request.
- **All Bilibili HTTP calls go through Rust**. Frontend never fetches Bilibili APIs directly — it calls `invoke()` to reach Tauri commands. JS args are camelCase, Rust params snake_case (Tauri converts automatically).
- **Data files next to exe**: `settings.json`, `credentials.json`, `app.log`, `data.db`. Atomic writes (tmp+rename) for JSON files.
- **Rename migration**: the rebrand changed `productName` → MSI installs into a NEW directory (UpgradeCode is productName-derived), so `migrate_legacy_data()` in `lib.rs` runs at startup in both GUI and `--mcp` modes: when the exe dir has no settings.json/data.db yet and a sibling `BilbliCopy` dir exists, it copies settings.json/credentials.json/data.db(+wal/shm) over. `install_app_update` likewise prefers launching `<parent>/Weiyu/Weiyu.exe` after install. Don't delete the legacy-dir reference — old installs must still be found.
- **System proxy**: On Windows, reads proxy from registry at startup in `init_system_proxy()`.

## Tauri commands (88 total)

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
- App update: `check_app_update`, `install_app_update`（自定义命令，见下节）

## App self-update (commands/app_update.rs)

- 设置字段 `update_channel`（`"r2"` 默认 | `"github"`）。不走 updater 插件的 JS API（它不能运行时换 endpoint），走自定义命令：按渠道选 latest.json 端点列表，R2 渠道依次 `copy.kaikun.top` → 桶自身 r2.dev 域 → GitHub 自动回退；`"github"` 只用 GitHub。下载进度经 `update://progress` 事件推送（downloaded/total/speed + 实际命中渠道，由安装包 URL host 推断）。
- CI（build.yml `assemble-latest-json` job）发版时用 wrangler 把 MSI/.sig/latest.json 上传到 R2 桶 `copy`（secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；安装包 URL 前缀可用仓库 Variable `R2_PUBLIC_BASE` 覆盖，默认 `https://copy.kaikun.top`）。桶根 `latest.json` 即 R2 渠道清单。
- 改名过渡（v1.4.1 起）：productName 变化 → MSI UpgradeCode 变化 → 首次跨名升级装进同级新目录而非原地覆盖。`install_app_update` 安装完成后优先拉起 `<旧目录>/../Weiyu/Weiyu.exe`，找不到才重启旧 exe；数据由 `migrate_legacy_data()`（lib.rs）在新版首次启动时从旧目录搬入。

## Batch download & subscriptions (commands/batch.rs, commands/subscription.rs)

- `batch_download_bvids(bvids, folder?)` / `batch_download_season(season_id)` resolve cids server-side, dedup against `download_history` (done/queued/downloading/paused skipped; error rows reuse their id via INSERT OR REPLACE), insert DB rows as `queued`, and submit to the download manager. 350ms pacing between per-video view lookups.
- Subscriptions (`subscriptions` table, schema 102): `kind` = `season`/`series`/`favorite`. Adding captures the current bvid list as baseline (only NEW items are auto-downloaded). A scheduler spawned in `lib.rs` setup ticks every 60s and checks all subscriptions when `settings.subscription_check_interval_min` > 0 (0 = off, default).

## MCP 服务（src/mcp/，`--mcp` 无头模式）

- 入口：`Weiyu.exe --mcp`（`main.rs` 分支 → `lib.rs::run_mcp`；dev 下是 `weiyu.exe --mcp`）。AI 客户端（Claude Desktop / ZCode / Cursor）以管道 stdio 拉起**无头实例**，经 rmcp 3.x（`server` + `transport-io` features）跑 MCP 协议。设置字段 `mcp_enabled` 默认 **false**：关闭时 `--mcp` 打印 stderr 提示并 exit(1)；UI 在 `settings/McpTab.tsx`（开关 + 客户端配置片段复制，exe 路径来自 `get_app_info` 命令）。
- 无头实例与桌面 App 的差异：无窗口/托盘/biliproxy，**不启动订阅调度器**（归 GUI，避免双份自动下载）；DB 用 `db::init_db_without_recover()` —— 绝不能跑「在途任务改 paused」的 GUI 崩溃恢复，否则每次被拉起会误停 GUI 正在下载的任务。两者并发读写同一 `data.db`（WAL + `busy_timeout=5000`），共享 `credentials.json`（DPAPI 同用户）。
- **stdout 纪律**：MCP JSON-RPC 走 stdout；`run_mcp` 用 `init_mcp_logger`（仅文件），任何新模式下的 `println!` 都会破坏协议。
- 工具层 `mcp/tools.rs`：**54 个工具**，**薄封装直接调用 `commands::*` 命令函数**（Tauri 命令即普通函数，`State<DbState>` 用 `app.state::<DbState>()` 构造后传入）；返回裁剪版 JSON 省 token；`RISK_CONTROL:` 前缀错误翻译为「回桌面应用完成验证」指引。单视频提交复用 `batch.rs::submit_video`（带 `SubmitOptions{qn, subtitle_only, audio_only}`，返回 `Option<task_id>`，None=去重跳过）。
- 覆盖范围：发现（搜索/热搜/榜单/推荐/分区/每周必看/入站必刷/动态/观看历史）、解析、视频信息、**评论区+楼中楼**、**官方 AI 总结**、弹幕（限量）、字幕轨道+正文、专栏正文、UP 资料/投稿/粉丝关注、收藏夹/稍后再看/追番、下载控制（单/批量/整季/暂停/取消/优先级/删除/统计）、订阅追更、互动（点赞/投币/收藏/稍后再看）、登录状态、应用设置只读。
- **刻意不暴露**（GUI 专属，勿"补全"）：登录扫码/登出流程与验证码（captcha_*，需 GUI 交互）、设置写入与指纹生成（save/patch_settings、fingerprint_*，配置归用户）、下载历史簿记写命令（save_download_entry/update_download_status/clear_*，会破坏任务状态一致性）、播放器内部（get_play_streams/get_seek_index/get_videoshot——流地址与字节索引对 AI 无意义）、专栏 markdown 导出、应用更新安装。
- 全局限速：`mcp::rate_limit` 令牌桶（容量 = 1 秒配额）——42 个B站网络类工具入口先 `acquire_bili()`；速率 = `mcp_rate_limit_per_sec`（默认 2，0 = 不限，clamp ≤100，改设置即时生效）。本地 SQLite/文件类工具（list_downloads、get_login_status 等）不限速；GUI 不走此路径、不受影响。
- 冒烟测试：`node examples/mcp_smoke.mjs src-tauri/target/debug/weiyu.exe`（最小 stdio 客户端：initialize → tools/list → 真实工具调用，含评论区/AI总结/弹幕/字幕与限速计时验证）。

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
