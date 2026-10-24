import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/player",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1080, height: 720 },
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: "pnpm exec vite --config tests/player/vite.config.ts",
    url: "http://127.0.0.1:3101",
    reuseExistingServer: !process.env.CI,
  },
});
