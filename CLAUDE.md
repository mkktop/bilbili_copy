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

## Architecture

Tauri 2 desktop app: Rust backend + React 18 frontend (Vite + Tailwind CSS).

### Backend (`src-tauri/src/`)

Two module layers:
- **`commands/`** — `#[tauri::command]` handlers, parameter validation, orchestration. Registered in `lib.rs` via `generate_handler![]`.
- **`bilibili/`** — Core business logic, organized by B站 API domain:
  - `passport.rs` — QR login flow (seed buvid → generate QR → poll → extract cookies → validate)
  - `credential.rs` — `Credential` struct, file persistence (`credentials.json`), cookie header builder
  - `client.rs` — HTTP client wrapper (skeleton, unused)
  - `video.rs` — `VideoInfo` struct (skeleton, unused)

Data files stored next to exe: `settings.json`, `credentials.json`.

### Frontend (`src/`)

- **Views:** `App.tsx` toggles between `"main"` and `"settings"` via state (no router).
- **Hooks:** `useLogin`, `useSettings` — call `invoke()` to reach Rust commands.
- **Contexts:** `UpdateContext` — auto-update lifecycle (check/download/install).
- **Styling:** Tailwind utility classes only, `cn()` from `lib/utils.ts` for conditional merging.
- **Icons:** `lucide-react`.
- **QR login:** `LoginDialog` generates QR via `qrcode` npm package, polls every 3s.

### Shared Types (Frontend ↔ Rust)

Rust serde enums/structs serialize to JSON consumed by TypeScript hooks. Enums must use `#[serde(rename_all = "snake_case")]` to match frontend string literals. Key types: `AppSettings`, `UserInfo`, `QrPollResult`, `Credential`.

## Key Conventions

- All Bilibili HTTP calls go through Rust backend (no direct fetch from frontend).
- `reqwest` clients in `passport.rs` are created per-function (not shared) to avoid cookie jar contamination during login.
- CSP in `tauri.conf.json` must include B站 CDN domains (`*.hdslb.com`, `*.bilibili.com`) for avatar images.
- localStorage prefix for update state: `bilibili_dl:`.
- System proxy detection reads Windows registry on startup (`init_system_proxy()` in `lib.rs`).

## Not Yet Implemented

- `commands/video.rs` — `parse_video` is a stub
- `commands/download.rs` — `download_video` is a stub
- `bilibili/client.rs` — Not integrated with commands yet
- `bilibili/video.rs` — `parse_video_info` is a stub
