<p align="center">
  <a href="https://github.com/mkktop/bilbili_copy">
    <img src="src-tauri/icons/128x128@2x.png" width="120" height="120" alt="BilbliCopy" />
  </a>
</p>

<h1 align="center">BilbliCopy</h1>

<p align="center">
  一个现代化的轻量级 B 站视频下载桌面客户端，基于 Tauri 2（Rust + React）打造。
  <br />
  快速 · 简洁界面 · 多线程 · 防风控
</p>

<p align="center">
  <a href="./README.md">English</a>
  ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/mkktop/bilbili_copy/releases/latest">
    <img src="https://img.shields.io/github/v/release/mkktop/bilbili_copy?style=flat-square&logo=github&color=blue" alt="Release" />
  </a>
  <a href="https://github.com/mkktop/bilbili_copy/releases/latest">
    <img src="https://img.shields.io/github/downloads/mkktop/bilbli_copy/total?style=flat-square&color=blue" alt="Downloads" />
  </a>
  <img src="https://img.shields.io/badge/平台-Windows-0078D4?style=flat-square&logo=windows" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2-orange?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/许可证-MIT-green?style=flat-square" alt="License" />
</p>

<p align="center">
  <a href="#-功能特性">功能特性</a>
  ·
  <a href="#-界面预览">界面预览</a>
  ·
  <a href="#-安装">安装</a>
  ·
  <a href="#-从源码构建">从源码构建</a>
  ·
  <a href="#-架构">架构</a>
  ·
  <a href="#-参与贡献">参与贡献</a>
</p>

---

> [!NOTE]
> 这是一个第三方、社区驱动的工具，**与哔哩哔哩无关，也未被其认可或赞助**。请在遵守 B 站服务条款及当地法律法规的前提下使用。请仅下载你有权访问的内容。

## ✨ 功能特性

### 📥 下载能力
- **最高支持 8K / HDR** 画质，可配置编码优先级（AVC / HEVC / AV1）及 Hi-Res 无损音质
- **多线程断点续传** —— 支持并发任务、优先级排队、运行时暂停 / 取消
- **批量处理** —— 一键解析并下载整个合集、收藏夹、稍后再看列表，以及 UP 主的全部投稿
- **限速与并发控制** —— 自由调节并行线程数与单任务限速
- **系统托盘 + 后台模式** —— 关闭窗口后下载继续进行，完成后桌面通知提醒

### 🔐 账号与登录
- **扫码登录** —— 安全的 Web Cookie 流程，密码绝不经过本应用
- **Cookie 自动刷新** —— 跨会话保持登录状态
- **凭据本地持久化** —— 仅存储于本地，绝不上传

### 🧭 浏览与发现
- 首页推荐、排行榜、分区、观看历史、关注、订阅合集
- 搜索、视频评论，以及一键三连（点赞 / 投币 / 收藏）

### 🛡️ 防风控
- 可配置的**设备指纹**（GPU / 分辨率预设）
- 请求节流与防滥用节奏控制，保护账号健康

### 🎬 附加内容
- **弹幕** —— 可调节字号、滚动时长、透明度，支持屏蔽顶/底弹幕
- **字幕** —— 导出为 SRT 或 VTT
- **NFO 元数据刮削** —— 生成 Kodi / Jellyfin / Emby 兼容的 `.nfo` 文件 + 封面图

### 🎨 使用体验
- 简洁响应式界面，支持**浅色 / 深色 / 跟随系统**主题
- 内置通过 GitHub Releases 的**自动更新**
- 持久化的解析与下载历史，附带统计面板

## 📸 界面预览

<table>
  <tr>
    <td width="33%" align="center"><b>首页 —— 解析与下载队列</b></td>
    <td width="33%" align="center"><b>设置页</b></td>
    <td width="33%" align="center"><b>个人主页</b></td>
  </tr>
  <tr>
    <td width="33%" align="center"><img src="docs/screenshots/home.png" alt="首页"></td>
    <td width="33%" align="center"><img src="docs/screenshots/settings.png" alt="设置页"></td>
    <td width="33%" align="center"><img src="docs/screenshots/profile.png" alt="个人主页"></td>
  </tr>
  <tr>
    <td width="33%" align="center">粘贴链接，一键解析，加入下载队列。</td>
    <td width="33%" align="center">视频质量、下载、字幕弹幕、防风控、主题、托盘等。</td>
    <td width="33%" align="center">收藏夹、观看历史、稍后再看、关注、订阅。</td>
  </tr>
</table>

## 📦 安装

### 方式一 —— 直接下载（推荐大多数用户）

1. 前往 [最新发布版本](https://github.com/mkktop/bilbili_copy/releases/latest)。
2. 下载 `.msi` 安装包。
3. 运行安装程序并启动 **BilbliCopy**。

程序已自动内置 `ffmpeg.exe`，无需额外配置。

### 方式二 —— 从源码构建

见下方 [从源码构建](#-从源码构建)。

## 🚀 从源码构建

### 环境要求

- [Node.js](https://nodejs.org/) 20+ 与 [pnpm](https://pnpm.io/) 9+
- [Rust](https://www.rust-lang.org/tools/install)（stable 工具链）
- Windows 10+ 及 [Microsoft C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（或安装含 *使用 C++ 的桌面开发* 工作负载的 Visual Studio）
- [WiX Toolset 3.14](https://wixtoolset.org/)（用于打包 `.msi`）

### 步骤

```bash
# 1. 克隆仓库
git clone https://github.com/mkktop/bilbili_copy.git
cd bilbili_copy

# 2. 安装前端依赖
pnpm install

# 3. 开发模式运行（启动 Vite + 编译 Rust）
pnpm dev

# 4. 或构建生产版 MSI 安装包
pnpm build
```

安装包将生成于 `src-tauri/target/release/bundle/` 目录下。

## 🏗️ 架构

BilbliCopy 是一个 **Tauri 2** 应用：Rust 后端处理全部网络与文件 I/O，搭配 React 18（Vite + Tailwind CSS）前端。

```
┌──────────────────────────────────────────────────────────┐
│                     前端 (React 18)                        │
│        视图 · Hooks · Context · Tailwind · lucide 图标     │
└────────────────────────┬─────────────────────────────────┘
                         │  invoke() / 事件
┌────────────────────────▼─────────────────────────────────┐
│                    后端 (Rust)                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │  commands/   │   │  bilibili/   │   │ download_mgr │  │
│  │  (命令处理)  │──▶│  (接口逻辑)  │   │  (调度器)    │  │
│  └──────────────┘   └──────────────┘   └──────────────┘  │
│            本地状态: SQLite · JSON · 日志                  │
└──────────────────────────────────────────────────────────┘
```

- **`commands/`** —— `#[tauri::command]` 处理函数，负责参数校验与流程编排，在 `lib.rs` 中注册。
- **`bilibili/`** —— 核心业务逻辑，按 B 站接口域划分（`passport`、`credential`、`playurl`、`pgc`、`wbi`、`danmaku`、`subtitle`、`nfo` 等）。
- **`download_manager.rs`** —— 将「任务提交」与「任务执行」解耦：优先级队列、暂停 / 取消、并发信号量。
- **`db.rs`** —— 基于 `rusqlite` 的 SQLite（WAL 模式），schema 迁移内联管理。

> 所有 B 站 HTTP 请求均通过 Rust 后端发起 —— 前端绝不直接调用 B 站接口。

数据文件（`settings.json`、`credentials.json`、`data.db`、`app.log`）存放在可执行文件同级目录。更多开发细节见 [CLAUDE.md](./CLAUDE.md) 与 [AGENTS.md](./AGENTS.md)。

## 🔧 技术栈

| 层级     | 技术                                                    |
| -------- | ------------------------------------------------------- |
| 框架     | Tauri 2                                                 |
| 后端     | Rust 2021、tokio、reqwest、rusqlite、prost              |
| 前端     | React 18、TypeScript、Vite 7                            |
| 样式     | Tailwind CSS 3                                          |
| 图标     | lucide-react                                            |
| 打包     | WiX (MSI)，内置 ffmpeg                                  |
| 更新     | tauri-plugin-updater（基于 GitHub Releases）            |

## 🤝 参与贡献

欢迎贡献代码！请注意本仓库目前**未配置 linter、formatter 或测试套件** —— 请保持改动整洁，并与周边代码风格一致。

1. Fork 仓库并创建功能分支。
2. 完成修改，并通过 `pnpm typecheck` 与 `cd src-tauri && cargo check` 验证。
3. 提交 Pull Request，说明**改了什么**以及**为什么改**。

对于较大的功能，请先开 Issue 讨论设计方案。

## 🗺️ 路线图

- [ ] macOS / Linux 版本
- [ ] 更完善的界面截图文档
- [ ] 插件 / 主题可扩展性
- [ ] NFO 刮削的更多元数据来源

## ⚖️ 许可证

本项目基于 **MIT 许可证**开源，详情见 [LICENSE](./LICENSE)。

## ⚠️ 免责声明

BilbliCopy 是一个**仅用于个人学习与技术交流的非官方开源项目**。

- 本项目**与哔哩哔哩官方无任何关联，也未被其认可或赞助**。
- 所有视频内容、商标及版权均归哔哩哔哩及相应内容创作者所有。
- 用户需自行确保遵守 B 站服务条款及相关著作权法。**请仅下载你有权访问的内容，切勿用于商业用途的二次分发。**
- 维护者不对因不当使用本软件而产生的任何后果承担责任。

若您为权利方且认为本项目侵犯了您的权益，请提交 Issue，我们将及时处理。

## 🙏 鸣谢

- [Tauri](https://tauri.app/) —— 本应用的基石
- [哔哩哔哩](https://www.bilibili.com/) —— 提供了优秀的平台
- 我们 `Cargo.toml` 与 `package.json` 中每一个依赖背后的开源社区

---

<p align="center">
  用 ❤️ 为 B 站社区打造。<br/>
  如果这个项目对你有帮助，欢迎给个 ⭐！
</p>
