## v0.7.5 更新内容

### ✨ 新功能

- **下载统计面板**：顶部导航新增 📊 统计入口，进入独立「下载统计」视图，展示：
  - **累计下载视频数**（已完成数量 + 全部记录数）
  - **总大小**（已完成下载的总字节数，自动换算 B/KB/MB/GB）
  - **总时长**（已完成下载的总时长，自动换算为 `Xh Ym` 形式）

- **统计口径采用累加器**：下载完成时直接累加到独立的 `download_stats` 表，与下载历史解耦。
  - **删除/清空下载列表中的视频，累计统计不会回退**——记录的是"曾经下载过多少"。
  - 重试/重复完成同一视频只计一次（仅在状态从非 done 转为 done 时累加）。

### 🗄️ 数据库变更

- **v4 schema 迁移**：`download_history` 表新增 `size`（最终文件字节数）、`duration`（视频时长秒）两列。
  - 下载完成时由 `std::fs::metadata` 计算最终文件大小落库；时长在提交下载时写入。
- **v5 schema 迁移**：新建 `download_stats` 累加器表（单行）。
  - 升级时自动把已有 `status='done'` 记录回填进累加器，历史数据不丢失。
- 两步迁移均幂等（`column_exists` / `CREATE TABLE IF NOT EXISTS` 保护），老用户平滑升级。

### 📝 说明

- 影响：后端 `db.rs` / `commands/history.rs` / `bilibili/download.rs` / `download_manager.rs` / `lib.rs`；前端 `App.tsx` / `types.ts` / `lib/utils.ts` 及新组件 `StatsPanel.tsx`。
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送。
