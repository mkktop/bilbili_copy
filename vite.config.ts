import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src",
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React 运行时单独分包：业务代码迭代不影响 vendor chunk 的浏览器缓存；
        // 懒加载的 SettingsPage/StatsPanel/VideoPlayer 由 React.lazy 自动拆 chunk。
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
        },
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
});
