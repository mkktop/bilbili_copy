# 未雨服务器 CLI / MCP

服务器版独立于 Tauri，可部署到 **Linux ARM64（aarch64）** 和 **Linux x86_64（Intel/AMD 64位）**。发布包为 musl 静态可执行文件，不需要桌面环境、浏览器、Node.js、Python 或 FFmpeg；联网查询仍需系统 CA 证书。桌面版继续使用原有界面与 MCP，两个版本复用 `weiyu-core` 中的 B 站 API 实现。

服务器版提供 35 个只读查询工具：搜索、热搜、推荐、榜单、视频详情/分P、UP主资料与投稿、评论/楼中楼、字幕、弹幕、官方 AI 总结、专栏/opus、收藏夹、关注、观看历史等。提供普通 JSON 命令、stdio MCP 和远程 **Streamable HTTP MCP**，三种入口使用同一份工具定义。不提供下载、点赞、投币、删除、设置写入等工具。

## 安装二进制

构建包名称：

| 服务器架构 | 文件 |
| --- | --- |
| `aarch64` / `arm64` | `weiyu-cli-linux-arm64.tar.gz` |
| `x86_64` / `amd64` | `weiyu-cli-linux-x86_64.tar.gz` |

GitHub Actions 的 **CLI and Shared Core → Artifacts** 提供构建产物及 SHA-256；本地构建输出到 `artifacts/`。带版本标签的正式发布会同时附加到 GitHub Release。

```sh
uname -m
sha256sum -c weiyu-cli-linux-arm64.tar.gz.sha256
mkdir weiyu-cli
tar -xzf weiyu-cli-linux-arm64.tar.gz -C weiyu-cli
cd weiyu-cli
./weiyu-cli --version
sudo install -m 0755 weiyu-cli /usr/local/bin/weiyu-cli
```

x86_64 使用对应的压缩包。若系统未安装 CA 证书，Debian/Ubuntu 安装 `ca-certificates`，Alpine 安装同名包。

## JSON 命令

```sh
weiyu-cli tools
weiyu-cli call parse_url --args '{"url":"BV17x411w7KC"}'
weiyu-cli video 'https://www.bilibili.com/video/BV17x411w7KC'
weiyu-cli search 'Rust 入门' --page 1
weiyu-cli call get_hot_search --args '{"limit":10}'
weiyu-cli call get_video_comments --args '{"bvid":"BV17x411w7KC","sort":"hot","page":1}'
```

`tools` 输出名称、说明和 JSON Schema，可供 AI 自动选择工具。`call` 支持全部工具，`--args -` 从 stdin 读取 JSON。成功时结果写入 stdout；失败输出 `{"error":{"code":"...","message":"..."}}` 并返回非零退出码，诊断写入 stderr。

## 配置 B 站登录态

部分公开查询可匿名使用。搜索、字幕、官方 AI 总结及个人列表需要 Cookie。服务器管理员在自己已登录 B 站的浏览器开发者工具中找到 B 站请求，将 **Cookie 请求头的值**保存为单行 UTF-8 文件，例如 `/etc/weiyu/bilibili.cookie`，然后配置：

```sh
export WEIYU_COOKIE_FILE=/etc/weiyu/bilibili.cookie
weiyu-cli call get_login_status
weiyu-cli call get_current_user
```

也可使用 `--cookie-file /path/to/bilibili.cookie`。文件只在启动时读取，HTTP 服务更新 Cookie 后需重启；普通 CLI 每次执行重新读取。空文件表示匿名运行。`get_login_status` 的 `configured` 仅表示已提供凭据，`get_current_user` 会联网验证。不要使用桌面版的 Windows DPAPI 加密 `credentials.json`，它不能跨系统和账户迁移。

服务不会将 Cookie 返回给 AI，也不会自动修改浏览器或桌面凭据。B 站要求验证码时，完成验证后更新 Cookie；失败会返回 `BILIBILI_VERIFICATION_REQUIRED` 或上游错误。

## 远程 HTTP MCP

HTTP 服务始终需要至少 32 字符的 Bearer 令牌，可用 `--token-file`、`WEIYU_MCP_TOKEN_FILE` 或 `WEIYU_MCP_TOKEN` 提供。令牌文件优先于环境变量。

```sh
umask 077
openssl rand -hex 32 > mcp-token
weiyu-cli serve \
  --listen 127.0.0.1:8787 \
  --token-file ./mcp-token \
  --allowed-host mcp.example.com \
  --allowed-host 127.0.0.1
```

MCP 路径是 **`/mcp`**；`/healthz` 是不需要令牌的简洁健康检查。默认只监听本机，供反向代理接入。对外域名或 IP 必须通过 `--allowed-host` 或逗号分隔的 `WEIYU_ALLOWED_HOSTS` 指定。若直接监听外网，可改为 `--listen 0.0.0.0:8787` 并将实际域名/IP 加入允许的 Host。

Caddy 示例（替换为自己的域名）：

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

AI 客户端连接 `https://mcp.example.com/mcp`，携带 `Authorization: Bearer <mcp-token文件中的值>`。本服务使用静态 Bearer 令牌；客户端需支持自定义请求头或令牌配置。

支持 Streamable HTTP 的客户端配置示例：

```json
{
  "mcpServers": {
    "weiyu": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <你的访问令牌>" }
    }
  }
}
```

不同客户端的配置字段可能不同。Codex 可使用：

```toml
[mcp_servers.weiyu]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "WEIYU_MCP_TOKEN"
```

HTTP 使用无状态请求响应，兼容需要 initialize 的 MCP 客户端；不要求会话粘滞。带 `Origin` 的请求默认拒绝，可用 `--allowed-origin https://client.example.com:443` 显式允许。默认每秒 2 次工具查询、最多 4 个并发、45 秒超时；可用 `WEIYU_RATE_LIMIT`、`WEIYU_MAX_CONCURRENCY`、`WEIYU_TIMEOUT_SECS` 调整。超时、并发满和上游失败会作为 AI 可见的工具错误返回。

验证连接：

```sh
curl http://127.0.0.1:8787/healthz
export WEIYU_MCP_TOKEN="$(cat mcp-token)"
curl http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $WEIYU_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## systemd 常驻

以下在安装包解压目录执行；源码仓库内的同名模板位于 `deploy/server/`。

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin weiyu
sudo install -d -o weiyu -g weiyu -m 0700 /etc/weiyu
sudo install -o weiyu -g weiyu -m 0600 mcp-token /etc/weiyu/mcp-token
sudo install -o weiyu -g weiyu -m 0600 /dev/null /etc/weiyu/bilibili.cookie
sudo install -m 0644 weiyu-cli.service /etc/systemd/system/weiyu-cli.service
sudo install -o weiyu -g weiyu -m 0600 weiyu.env.example /etc/weiyu/weiyu.env
# 编辑 /etc/weiyu/weiyu.env 的对外Host，按需填写bilibili.cookie
sudo systemctl daemon-reload
sudo systemctl enable --now weiyu-cli
sudo journalctl -u weiyu-cli -f
```

服务接收 SIGTERM/Ctrl+C 后停止接收请求并退出。Cookie 与访问令牌更新后运行 `sudo systemctl restart weiyu-cli`。

## Docker / Compose

在源码仓库执行，Docker 会按当前服务器架构构建，无需桌面依赖：

```sh
cd deploy/server
mkdir -m 0700 secrets
openssl rand -hex 32 > secrets/mcp-token
touch secrets/bilibili.cookie
chmod 0644 secrets/mcp-token secrets/bilibili.cookie
cp .env.example .env
# 修改.env中的WEIYU_PUBLIC_HOST，按需填写secrets/bilibili.cookie
docker compose up -d --build
docker compose logs -f
```

`secrets` 目录保持 0700，单独挂载的文件设为 0644，供容器内非 root 用户读取。服务绑定宿主机 `127.0.0.1:8787`，由宿主机的反向代理提供 HTTPS。Cookie 文件留空即可匿名运行。

如需构建并推送自己的多架构镜像：

```sh
docker buildx build --platform linux/arm64,linux/amd64 \
  -f deploy/server/Dockerfile -t <你的镜像地址>:<版本> --push .
```

## stdio MCP

同机 AI 客户端可以直接运行 `weiyu-cli mcp`，跨机可通过 SSH 启动。stdio 模式不需要 HTTP 访问令牌，协议独占 stdout，日志只写 stderr。独立 CLI 无需打开桌面版的 MCP 开关。

```json
{
  "mcpServers": {
    "weiyu": {
      "command": "/usr/local/bin/weiyu-cli",
      "args": ["--cookie-file", "/etc/weiyu/bilibili.cookie", "mcp"]
    }
  }
}
```

## 从源码构建与验证

```sh
cargo test --workspace --no-default-features --locked
cargo build -p weiyu-cli --release --locked

# 静态跨架构构建：构建机安装Python、Rust与C编译器
pip install cargo-zigbuild==0.24.0 ziglang==0.14.1
rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl
cargo zigbuild --locked -p weiyu-cli --release --target aarch64-unknown-linux-musl
cargo zigbuild --locked -p weiyu-cli --release --target x86_64-unknown-linux-musl
bash scripts/package-cli.sh aarch64-unknown-linux-musl
bash scripts/package-cli.sh x86_64-unknown-linux-musl
```

协议测试覆盖 HTTP 初始化/工具列表/调用、Bearer 认证、Host/Origin 校验、请求大小、结构化错误、stdio 协议纯净性和命令行退出码。共享库沿用原 B 站解析测试。CI 同时编译 Windows 桌面版，防止共享库调整破坏桌面调用。真实账号权限、Cookie有效性和服务器出口IP是否触发B站验证，需在部署服务器上以实际账号验证。
