## v0.6.6 更新内容

### ✨ 新增

#### PGC 排行榜（番剧/国创/电影/电视剧/纪录片/综艺）
- 排行榜页顶部新增「UGC 视频 / PGC 内容」二选一切换
- 切到 PGC 后，分区筛选自动切换为 6 个 PGC 分类：国创/番剧/电影/电视剧/纪录片/综艺
- API: `https://api.bilibili.com/pgc/season/rank/web/list?season_type=&day=3`
- 卡片：横向封面 + 状态徽章（如「全12话」「已完结」）+ 综合分（金色高亮，PGC 接口真实返回，UGC 接口 v2 缺该字段）
- **点击 PGC 卡片** → 解析 `https://www.bilibili.com/bangumi/play/ss{season_id}` → 跳到 `VideoDetail` 选集页，可批量下载所有集数

### 🔧 复用与实现亮点

- **零新增下载/解析逻辑**：PGC 详情完全复用现 `video::try_bangumi_season_info`（`/pgc/view/web/season?season_id=X`）和 `VideoDetail` 组件
- **零 URL 解析改动**：`url::parse_bilibili_url` 已支持 `/bangumi/play/ss{season_id}`，无需扩展
- PGC 排行榜数据维度是**番剧季**（非单视频），点击跳到选集页是天然语义

### 🐛 修复

- **「全站榜 vs 游戏榜内容对不上」的误解澄清**：本应用排行榜数据来自 B站**公开 API**（`/ranking/v2`），而主站 `/v/popular/rank/game` 网页显示的是 B站**内部带运营干预**的数据源（含编辑推荐、UP 主扶持等）。前者是公开可获取的「客观榜单」，后者是产品运营「人工干预榜」——**两者结构性不同**。本应用如实展示公开 API 数据。

## 升级说明

- 本次未改动数据库 schema，升级无数据迁移
- PGC 排行榜为实时 API，不落库
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送
