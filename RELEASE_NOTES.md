## v1.6.0 · 服务器 CLI 与全新工作区

### Linux 服务器 CLI / MCP
- 新增独立的 Linux ARM64（aarch64）与 x86_64（Intel/AMD 64 位）CLI，提供 musl 静态可执行文件，无需桌面环境、浏览器、Node.js 或 FFmpeg。
- 支持普通 JSON 命令、stdio MCP 和远程 Streamable HTTP MCP，统一提供 35 个只读查询工具：搜索、视频详情、评论、字幕、弹幕、官方 AI 总结、专栏、UP 主、收藏与观看历史等。
- HTTP MCP 提供 Bearer 令牌认证、Host/Origin 验证、限速、并发控制、超时及结构化错误；B 站 Cookie 通过管理员指定的文件加载。
- 提供安装包校验和、systemd、非 root Docker/Compose 以及 AI 客户端配置示例。
- 桌面版与 CLI 复用共享 Rust API 库，保留原有桌面下载、播放和 MCP 功能。

下载服务器版时，ARM64 选择 `weiyu-cli-linux-arm64.tar.gz`，x86_64 选择 `weiyu-cli-linux-x86_64.tar.gz`；Windows 桌面版选择 MSI。搜索、字幕、AI 总结及个人列表等接口需要配置有效的 B 站 Cookie。

[服务器部署与 AI 客户端配置](https://github.com/mkktop/bilbili_copy/blob/master/docs/server-cli.md)

### 桌面工作区与页面布局
- 新增常驻侧栏和统一发现导航，在工作台、下载、搜索、推荐、排行榜与资料库之间切换更直接。
- 工作台展示链接解析入口、全库任务数量与最近解析记录；后台任务状态变化后刷新概览。
- 下载管理拆分批量操作与状态筛选，新增排队中分类；修复状态变化后未补入匹配任务、末页清空后无法继续查看的问题。
- 搜索筛选按需展开，联想支持键盘选择并忽略过期请求；改善资料库标签与深色、窄窗口布局。
- 设置改为分类导航和固定保存栏，跨类别保留草稿；修复切换主题覆盖未保存输入的问题，保存失败保留输入，离开时提示未保存修改。
- 修复非首页登录/验证弹窗不可见，以及专栏阅读层遮住导航目标页面的问题。

### 构建与验证
- 38 项共享 API、CLI 与 MCP 测试通过；两种 Linux 架构验证 JSON 命令、stdio/HTTP MCP 和正常退出，ARM64 使用 QEMU 运行验证。
- Windows 桌面类型检查、前端生产构建和 Rust 编译检查通过；保留现有播放器与工作区回归测试。
- Docker 验证非 root、只读文件系统、健康检查与 MCP 查询；两种架构及容器均成功查询公开 B 站热搜。实际账号权限及服务器出口验证要求仍以部署环境为准。
