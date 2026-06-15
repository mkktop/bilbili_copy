## v0.7.0 更新内容

### ✨ 新增

#### 推荐视频（导航栏 ✨ 入口）
- 顶部导航栏新增 ✨ 推荐按钮，调用首页推荐流 `https://api.bilibili.com/x/web-interface/index/top/rcmd`
- **个性化推荐需登录**：未登录显示「请登录」提示；登录后显示推荐视频列表
- 「换一批」刷新按钮（`fresh_idx` 递增，服务端据此去重「看过的不再推荐」）
- 卡片显示推荐理由徽章（如「关注」「赞过」），点击卡片进选集详情页

#### 分区浏览（导航栏 🔲 入口）
- 顶部导航栏新增 🔲 分区浏览按钮，调用 `https://api.bilibili.com/x/web-interface/dynamic/region`
- 按一级分区（动画/音乐/游戏/科技/生活/美食/舞蹈/时尚/动物/汽车/运动/鬼畜/影视/娱乐/科普）浏览**最新发布**视频
- 与排行榜（综合热度）是两套独立内容，已加语义说明避免误解
- 紫色主题区分排行榜（蓝/黄）与推荐（蓝）

#### 视频评论（详情页底部）
- 视频详情页底部新增评论区，调用 `https://api.bilibili.com/x/v2/reply?type=1&oid={aid}`
- 按热度排序（`mode=3`），分页「加载更多」
- 评论卡片：头像 + 用户名 + 等级徽章 + 楼层 + 正文（保留换行）+ 时间/点赞/回复数
- 顶部显示评论总数 + 刷新按钮

#### 视频互动（详情页操作栏：点赞 / 投币 / 收藏）
- 详情页统计行下方新增互动操作栏，需登录
- **点赞**：POST `/x/web-interface/archive/like`，可切换（粉色高亮表示已赞）
- **投币**：POST `/x/web-interface/coin/add`，投 1 枚
- **收藏**：POST `/x/v3/fav/resource/deal`，下拉选择目标收藏夹（复用现有 `get_favorite_folders`）
- 带 CSRF（`bili_jct`）+ Cookie；命中风控 `v_voucher` 时提示用户重试
- 操作反馈 toast，防并发 `busy` 锁

### 🔧 实现亮点

- **互动 API 无需 WBI 签名**：经核实 like/coin/favorite 是带 csrf 的 form POST，仅注入 `csrf=bili_jct` + Cookie 即可
- **统一 `interaction_post` helper**：三个互动操作复用同一请求函数，统一处理 Cookie 注入、csrf 表单、风控检测、报错
- **复用共享 `api_client()`**：本次新增的 recommend/region/comment 模块全部用带 `API_TIMEOUT` 超时的共享客户端，避免挂起连接永久阻塞
- **复用 `PagedResult<T>`**：评论分页直接复用既有的通用分页类型，与观看历史/投稿列表一致
- **零 URL 解析改动**：推荐/分区/评论卡片点击复用现 `bvid → onParseVideo → VideoDetail` 链路

### 🐛 修复

- **PGC 模块改用共享 `api_client()`**：原 `pgc.rs` 自建无超时的 HTTP 客户端，已改为复用 `mod.rs` 的 `api_client()`（带 15s `API_TIMEOUT`），消除挂起连接永久阻塞风险
- **PGC 卡片封面移除无效 `h-18`**：`h-18` 非 Tailwind 默认尺寸类不生效，改为由 `w-32` + `aspectRatio: 16/9` 单一来源决定尺寸
- **推荐流 `ps` 参数导致 -400**：B站 `/index/top/rcmd` 接口对 `ps` 有上限校验（`ps=30` 返回 -400「请求错误」），已去掉 `ps` 参数用接口默认值（实际返回约 24 条）

## 升级说明

- 本次未改动数据库 schema，升级无数据迁移
- 推荐/分区/评论/互动均为实时 API，不落库
- 互动操作（点赞/投币/收藏）需登录账号；未登录时推荐页显示登录提示，互动按钮 toast 提示登录
- Windows: 下载 `.msi` 或 `.exe` 安装包覆盖安装，应用内自动更新将在后台推送
