播放器回归测试直接挂载生产组件，使用真实 MSE 与本地 H.264/AAC 分片，Tauri 命令和 biliproxy 通过测试夹具提供。测试不访问 B 站。

```sh
pnpm install
pnpm exec playwright install chromium
pnpm test:player
pnpm test:ui # 播放器 + 完整应用工作区测试
```

也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium pnpm test:player` 使用已安装的 Chromium。前端生产构建不包含测试页面。

`workspace.html` 直接挂载生产 App、登录、更新和通知 Provider，通过官方 Tauri mocks 提供 IPC 与事件。虚构的本地 SVG 封面、账号、记录和全库数量只用于测试与截图。`workspace.spec.ts` 覆盖全局导航、跨页登录、后台任务数量刷新、下载筛选竞态、搜索联想键盘操作与请求竞态、设置草稿/保存失败/离开保护，以及 800×600 深色布局。使用 `pnpm test:ui` 运行全部用例。

夹具用 FFmpeg 生成，可复现：

```sh
ffmpeg -f lavfi -i 'color=c=0x23384b:s=320x180:r=12' -t 12 -an -c:v libx264 -profile:v high -pix_fmt yuv420p -g 24 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx tests/player/fixtures/video.mp4
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 12 -vn -c:a aac -b:a 32k -frag_duration 2000000 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx tests/player/fixtures/audio.mp4
ffmpeg -f lavfi -i 'color=c=0x23384b:s=180x320:r=12' -t 12 -an -c:v libx264 -profile:v high -pix_fmt yuv420p -g 24 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx tests/player/fixtures/portrait.mp4
```
