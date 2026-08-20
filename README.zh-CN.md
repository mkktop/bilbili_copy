<p align="center">
  <a href="https://github.com/mkktop/bilbili_copy">
    <img src="src-tauri/icons/128x128@2x.png" width="120" height="120" alt="BilbliCopy" />
  </a>
</p>

<h1 align="center">BilbliCopy</h1>

<p align="center">
  一个现代化的轻量级 B 站视频下载桌面客户端，基于 Tauri 2（Rust + React）打造。
  <br />
  快速 · 简洁界面 · 多线程 · 在线播放 · 防风控
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
    <img src="https://img.shields.io/github/downloads/mkktop/bilbili_copy/total?style=flat-square&color=blue" alt="Downloads" />
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

### 📥 视频下载
- **最高 8K / HDR / 杜比视界**画质，Hi-Res 无损与杜比全景声音质，编码优先级可自定义（AVC / HEVC / AV1）
- **多线程分片 + 断点续传**：暂停、退出重启都能接着下，跨会话续传由流指纹保护
- **批量下载**：多分P / 番剧全集 / 合集 / 收藏夹 / UP 主投稿，选中即下；支持仅音频（m4a/mp3）、仅字幕模式
- **下载队列管理**：并发数 / 限速可配，暂停 / 恢复 / 重试 / 优先级置顶，完成后系统通知
- **自定义文件名模板**：`{up}/{title} [{bvid}]` 等占位符自由组合，按 UP 主 / 合集自动归档
- **附加内容**：弹幕（ASS 渲染可配字号 / 速度 / 透明度）、字幕导出（SRT / VTT）、NFO 元数据刮削（Kodi / Jellyfin / Emby 直接入库）

### ▶️ 内置在线播放器
- 无需下载即点即播，画质自由切换，精准拖动秒到（sidx 索引），弱网自动重试不断播
- 实时弹幕、多语言字幕（含 AI 字幕）、倍速 0.5x–2x、分P 选集
- **播放列表连播**：跨稿件自动切下一集，配合「每周必看」一键连播整期
- 进度记忆续播、迷你小窗、系统画中画、全套键盘快捷键

### 🧭 内容浏览
- **发现**：综合搜索（视频 / UP 主 / 番剧 / 影视）+ 搜索历史 + B 站实时热搜榜
- **排行榜 / 推荐 / 分区 / 关注动态 / 每周必看**：五大浏览入口，覆盖 UGC 与番剧影视
- **个人中心**：收藏夹 / 稍后再看 / 观看历史 / 追番追剧 / 关注列表 / 订阅合集，长列表虚拟化滑动不卡
- **UP 主主页**：投稿 / 合集一键直达，详情页点头像即进
- **互动**：点赞 / 投币 / 收藏 / 一键三连，评论区浏览

### 📰 专栏阅读
- 粘贴 cv / opus 链接直接应用内阅读，排版干净（HTML 白名单净化）
- 导出 Markdown 落盘，或导出 PDF（多页分页、图片完整）

### 🛡️ 账号与防风控
- 扫码登录，Cookie 自动刷新；凭证经 Windows DPAPI 加密存储在本地，绝不上传
- 可配置设备指纹（GPU / 分辨率预设）与请求节流，触发风控时弹窗完成验证即可继续
- 大会员 / 充电 / 付费内容无权限时明确提示，不会误把试看片段当正片下载

### ⚙️ 体验细节
- 深色 / 浅色 / 跟随系统主题；复制链接自动识别填入，拖拽链接入窗即解析
- 关闭窗口最小化到托盘，后台继续下载；下载统计面板（累计数量 / 大小 / 时长）
- 应用内自动更新；全部 API 连接池化，浏览与解析响应迅速

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
2. 完成修改，并通过 `pnpm typecheck` 与 `cd src-tauri && cargo check && cargo test` 验证。
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
