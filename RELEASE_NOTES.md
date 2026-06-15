## v0.7.4 更新内容

### 🐛 修复

- **视频详情页收藏操作失败**：在视频详情页对视频进行收藏时，提示"操作失败: 请求错误"。
  - 根因：`bilibili/interaction.rs` 中 `favorite_video` 调用 `POST https://api.bilibili.com/x/v3/fav/resource/deal` 时，把表单字段名写成了 `oid` / `tid`（旧版/其它接口的字段名），但当前接口要求的字段是 `rid`（资源 ID）和 `add_media_ids`（要加入的收藏夹 media_id），服务端因缺少必填参数拒绝请求。
  - 修复：将表单字段名修正为 `rid` 和 `add_media_ids`，同步更新函数注释。`like_video` / `coin_video` 的参数名本来正确，不受影响。
  - 影响范围：仅视频详情页 `InteractionBar` 的「收藏」按钮。点赞、投币功能未受影响。

### 📝 说明

- 本次未改动数据库 schema，升级无数据迁移
- 仅 Rust 后端一处文件改动（`src-tauri/src/bilibili/interaction.rs`），前端无变更
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送
