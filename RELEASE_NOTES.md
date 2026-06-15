## v0.7.2 更新内容

### ✨ 新增

#### 深色 / 浅色主题切换
- 设置页「通用」tab 新增「外观」分区，提供 **浅色 / 深色 / 跟随系统** 三种主题模式
- **跟随系统**：读取 Windows 的浅色/深色偏好自动联动，系统切换时应用即时跟随
- **主界面顶栏快捷按钮**：太阳/月亮图标，一键在浅色↔深色间切换，无需进设置
- **防首屏闪烁**：`index.html` 内联脚本在首帧前根据偏好应用 `.dark` 类，重启/刷新无白闪
- 主题偏好持久化到 `settings.json`，跨重启保留
- 设置位置：设置 → 通用 → 外观

### 🔧 实现亮点

- **语义化 Token 系统**：采用 CSS 变量 + Tailwind 语义色方案（而非 `dark:` 变体）。在 `index.css` 的 `:root`/`.dark` 定义 10 个语义色变量（base/panel/line/ink/accent 等），在 `tailwind.config.cjs` 注册为语义名（`bg-panel`/`text-ink`/`border-line`...）。主题切换由 `<html>` 的 `.dark` 类整体翻转，每个颜色类只写一次
- **全量颜色迁移**：扫描替换了 28 个文件中所有硬编码的 `bg-white`/`bg-gray-*`/`text-gray-*`/`border-gray-*` 为语义 token，保留语义性状态色（green/red/amber 状态、blue/purple 品牌强调色）
- **即时保存模式**：主题切换复用 `AboutTab` 的 Pattern B（直接调 `save`，不走表单保存按钮），与 auto_update 开关一致
- **useTheme Hook**：解析 `light/dark/system`，监听 OS `prefers-color-scheme`（仅 system 模式响应），提供 `toggle()` 在 light↔dark 间翻转
- **后端无缝迁移**：`theme` 字段带 serde default，旧 `settings.json` 缺该字段时回退 `light`，`LegacySettings` 迁移路径同步处理

### 📝 说明

- 蓝色品牌色（主按钮、选中态）、绿色/红色/琥珀色状态标识（下载中/完成/失败）在深浅两套主题下均保持不变
- 本次未改动数据库 schema，升级无数据迁移
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送
