<p align="center">
  <a href="https://github.com/mkktop/bilbili_copy">
    <img src="src-tauri/icons/128x128@2x.png" width="120" height="120" alt="BilbliCopy" />
  </a>
</p>

<h1 align="center">BilbliCopy</h1>

<p align="center">
  A modern, lightweight desktop client for downloading videos from Bilibili. Built with Tauri 2 (Rust + React).
  <br />
  Fast · Clean UI · Multi-threaded · Risk-control friendly
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a>
  ·
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/mkktop/bilbili_copy/releases/latest">
    <img src="https://img.shields.io/github/v/release/mkktop/bilbili_copy?style=flat-square&logo=github&color=blue" alt="Release" />
  </a>
  <a href="https://github.com/mkktop/bilbili_copy/releases/latest">
    <img src="https://img.shields.io/github/downloads/mkktop/bilbli_copy/total?style=flat-square&color=blue" alt="Downloads" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2-orange?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
</p>

<p align="center">
  <a href="#-features">Features</a>
  ·
  <a href="#-screenshots">Screenshots</a>
  ·
  <a href="#-installation">Installation</a>
  ·
  <a href="#-build-from-source">Build from Source</a>
  ·
  <a href="#-architecture">Architecture</a>
  ·
  <a href="#-contributing">Contributing</a>
</p>

---

> [!NOTE]
> This is a third-party, community-driven tool and is **not affiliated with, endorsed by, or sponsored by Bilibili**. Please use it in compliance with Bilibili's Terms of Service and your local laws. Download only content you are authorized to access.

## ✨ Features

### 📥 Downloading
- **Up to 8K / HDR** video quality, with codec priority (AVC / HEVC / AV1) and Hi-Res lossless audio
- **Multi-threaded, resumable downloads** — concurrent tasks, priority queue, pause / cancel at runtime
- **Batch support** — parse and download entire collections, favorites, watch-later lists, and a UP's submissions
- **Speed limit & concurrency control** — tune parallel threads and per-task throttling to taste
- **System tray + background mode** — close the window, downloads keep running; desktop notification on completion

### 🔐 Account & Auth
- **QR-code login** — secure web-cookie flow, no password ever touches the app
- **Automatic cookie refresh** — stays logged in across sessions
- **Credential persistence** — stored locally, never uploaded anywhere

### 🧭 Browse & Discover
- Explore, Rankings, Recommendations, Regions, Watch History, Followings, Subscriptions
- Search, video comments, and one-click interaction (like / coin / favorite)

### 🛡️ Risk-control Friendly
- Configurable **device fingerprint** (GPU / resolution presets)
- Request throttling and anti-abuse pacing to keep your account healthy

### 🎬 Extra Attachments
- **Danmaku** (comments) — render with adjustable font size, speed, opacity, top/bottom blocking
- **Subtitles** — export as SRT or VTT
- **NFO metadata scraping** — generate Kodi / Jellyfin / Emby compatible `.nfo` + cover art

### 🎨 Experience
- Clean, responsive UI with **light / dark / system** themes
- Built-in **auto-update** via GitHub Releases
- Persistent parse & download history with a statistics dashboard

## 📸 Screenshots

> Screenshots coming soon. Run the app locally or grab the latest build from [Releases](https://github.com/mkktop/bilbili_copy/releases/latest) to take a look.

## 📦 Installation

### Option A — Download (recommended for most users)

1. Go to the [latest release](https://github.com/mkktop/bilbili_copy/releases/latest).
2. Download the `.msi` installer.
3. Run the installer and launch **BilbliCopy**.

The bundled `ffmpeg.exe` is included automatically — no extra setup needed.

### Option B — Build from source

See [Build from Source](#-build-from-source) below.

## 🚀 Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/) 9+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Windows 10+ with [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (or Visual Studio with the *Desktop development with C++* workload)
- [WiX Toolset 3.14](https://wixtoolset.org/) (for `.msi` packaging)

### Steps

```bash
# 1. Clone
git clone https://github.com/mkktop/bilbili_copy.git
cd bilbili_copy

# 2. Install frontend dependencies
pnpm install

# 3. Run in development (starts Vite + compiles Rust)
pnpm dev

# 4. Or build a production MSI installer
pnpm build
```

The installer will be generated under `src-tauri/target/release/bundle/`.

## 🏗️ Architecture

BilbliCopy is a **Tauri 2** application: a Rust backend handling all network and file I/O, with a React 18 (Vite + Tailwind CSS) frontend.

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (React 18)                    │
│   Views · Hooks · Contexts · Tailwind UI · lucide icons   │
└────────────────────────┬─────────────────────────────────┘
                         │  invoke() / events
┌────────────────────────▼─────────────────────────────────┐
│                    Backend (Rust)                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │  commands/   │   │  bilibili/   │   │ download_mgr │  │
│  │  (handlers)  │──▶│  (API logic) │   │ (scheduler)  │  │
│  └──────────────┘   └──────────────┘   └──────────────┘  │
│            Local state: SQLite · JSON · log               │
└──────────────────────────────────────────────────────────┘
```

- **`commands/`** — `#[tauri::command]` handlers; parameter validation and orchestration, registered in `lib.rs`.
- **`bilibili/`** — Core business logic, organized by Bilibili API domain (`passport`, `credential`, `playurl`, `pgc`, `wbi`, `danmaku`, `subtitle`, `nfo`, …).
- **`download_manager.rs`** — Decouples task submission from execution: priority queue, pause / cancel, concurrency semaphores.
- **`db.rs`** — SQLite via `rusqlite` (WAL mode), schema migrations stored inline.

> All Bilibili HTTP calls go through the Rust backend — the frontend never fetches Bilibili APIs directly.

Data files (`settings.json`, `credentials.json`, `data.db`, `app.log`) live next to the executable. See [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md) for deeper developer notes.

## 🔧 Tech Stack

| Layer      | Technology                                             |
| ---------- | ------------------------------------------------------ |
| Framework  | Tauri 2                                                |
| Backend    | Rust 2021, tokio, reqwest, rusqlite, prost             |
| Frontend   | React 18, TypeScript, Vite 7                           |
| Styling    | Tailwind CSS 3                                         |
| Icons      | lucide-react                                           |
| Packaging  | WiX (MSI), bundled ffmpeg                              |
| Updates    | tauri-plugin-updater (GitHub Releases)                 |

## 🤝 Contributing

Contributions are welcome! Please note this repo currently has **no linter, formatter, or test suite** configured — keep changes clean and consistent with the surrounding code.

1. Fork the repository and create a feature branch.
2. Make your changes. Verify with `pnpm typecheck` and `cd src-tauri && cargo check`.
3. Open a Pull Request describing **what** and **why**.

For larger features, please open an issue first to discuss the design.

## 🗺️ Roadmap

- [ ] macOS / Linux builds
- [ ] More screenshot documentation
- [ ] Plugin / theme extensibility
- [ ] Additional metadata sources for NFO scraping

## ⚖️ License

This project is released under the **MIT License**. See [LICENSE](./LICENSE) for details.

## ⚠️ Disclaimer

BilbliCopy is an **unofficial, open-source project for personal study and technical exchange only**.

- It is **not affiliated with, endorsed by, or sponsored by Bilibili** or any of its affiliates.
- All video content, trademarks, and copyrights belong to Bilibili and the respective content creators.
- Users are solely responsible for complying with Bilibili's Terms of Service and applicable copyright laws. **Download only content you are authorized to access, and do not redistribute it for commercial purposes.**
- The maintainers assume no responsibility for any consequences arising from misuse of this software.

If you represent a rights holder and believe this project infringes your rights, please open an issue and we will address it promptly.

## 🙏 Acknowledgements

- [Tauri](https://tauri.app/) — the foundation this app is built on
- [Bilibili](https://www.bilibili.com/) — for the wonderful platform
- The open-source community behind every dependency listed in our `Cargo.toml` and `package.json`

---

<p align="center">
  Made with ❤️ for the Bilibili community.<br/>
  If you find this project helpful, please consider giving it a ⭐!
</p>
