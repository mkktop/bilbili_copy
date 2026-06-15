## v0.7.3 更新内容

### ✨ 新增

#### 下载列表交互增强
- **点击封面进入视频详情页**：下载列表每一项的封面（排队中 / 下载中 / 已完成 / 失败 等所有状态均可点）现在可点击，hover 时显示蓝色 ring 提示。点击后用 `bvid` / `epId` 重新解析视频信息并跳转到详情页；返回时下载列表的分页位置完整保留
- **一键打开下载文件所在目录**：「已完成」任务行新增文件夹图标按钮，点击后在系统资源管理器中打开并选中下载好的文件

#### 智能回退打开目录
- 若下载文件已被用户手动删除（`revealItemInDir` 失败），或该记录无 `output_path`，自动回退打开设置中配置的下载目录 `default_download_dir`，不再直接报错
- 三级兜底：① 选中文件 → ② 打开下载目录 → ③ 未配置下载目录时 toast 提示

### 🔧 实现亮点

- **零后端改动**：复用已安装的 `tauri-plugin-opener` 插件，直接调用 `revealItemInDir` / `openPath`，不新增 Tauri command、不动 DB schema
- **`outputPath` 字段补全**：`DownloadTask` 前端类型原本漏映射了 DB 已存储的 `output_path`，本次补齐字段定义与 `dbToDownloadTask` 映射，并在 `download://complete` 事件回调里同步写入，确保运行时刚完成的任务也带路径
- **详情跳转复用 `parse_video`**：用 `bvid` / `epId` 重建 URL 后重新解析，避免 schema 迁移，数据始终最新；解析失败时 toast 提示
- **下载视图保持挂载**：进入详情页时下载列表组件不卸载，与 profile / ranking 等页保持一致，返回时 state 完整保留

### 📝 说明

- 本次未改动数据库 schema，升级无数据迁移
- 历史已完成任务（升级前下载的）也支持打开目录：DB 中已有 `output_path` 字段，映射后自动可用
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送
