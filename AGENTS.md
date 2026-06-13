# AGENTS.md

## What this is

Tauri 2 desktop app (Windows-only) for downloading Bilibili videos. Rust backend + React 18 frontend (Vite + Tailwind CSS). Single-package repo, not a monorepo.

## Commands

```bash
pnpm dev                        # Full Tauri dev (starts Vite + compiles Rust)
pnpm build                      # Production build
pnpm typecheck                  # TypeScript only (tsc --noEmit)
cd src-tauri && cargo check     # Rust only
```

There is **no linter, formatter, or test suite** configured. Don't search for `eslint`, `prettier`, `cargo test`, or `vitest` — they don't exist.

## Architecture quirks an agent will trip on

- **Vite root is `src/`**, not the project root. `index.html` lives in `src/index.html`. Build output goes to `dist/` at project root.
- **Path alias**: `@/*` → `./src/*` (both in tsconfig and vite).
- **Crate name typo**: The Rust lib crate is `bilbli_copy_lib` (missing 'i'). `main.rs` calls `bilbli_copy_lib::run()`. Don't "fix" this — it matches `Cargo.toml`.
- **SQLite via rusqlite**: Database state (`DbState`) is Tauri-managed. Schema lives inline in `db.rs`. DB file (`data.db`) stored next to exe, uses WAL mode.
- **No shared reqwest client**: `bilibili/client.rs` exists but is unused. Each module creates its own reqwest client to avoid cookie jar contamination.
- **All Bilibili HTTP calls go through Rust**. Frontend never fetches Bilibili APIs directly — it calls `invoke()` to reach Tauri commands.
- **Data files next to exe**: `settings.json`, `credentials.json`, `app.log`, `data.db`. Atomic writes (tmp+rename) for JSON files.
- **System proxy**: On Windows, reads proxy from registry at startup in `init_system_proxy()`.

## Tauri commands (20 total)

Registered in `lib.rs` via `generate_handler![]`. Don't trust the CLAUDE.md count — it lists 10 but history commands were added later:

Settings: `get_settings`, `save_settings`
Video: `parse_video`
Download: `download_video`
Login: `login_generate_qrcode`, `login_poll_qrcode`, `login_check`, `login_logout`
Captcha: `captcha_register`, `captcha_validate`
Parse history: `get_parse_history`, `save_parse_history`, `delete_parse_history`, `get_parse_count`, `clear_parse_history`
Download history: `get_download_history`, `save_download_entry`, `update_download_status`, `delete_download_history`, `get_download_count`, `clear_download_history`

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

`download://progress`, `download://complete`, `download://error`, `download://risk_control`.

## Serde conventions

Rust types serialize to JSON consumed by TypeScript. Enums use `#[serde(rename_all = "snake_case")]`.

## Existing instruction files

- `CLAUDE.md` — detailed architecture reference. Some sections are stale (command count, missing db.rs and history commands). Use for module-level detail but verify against source.
