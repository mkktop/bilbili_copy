import { mergeConfig } from "vite";
import base from "../../vite.config";
import path from "node:path";

export default mergeConfig(base, {
  root: path.resolve(__dirname),
  server: { host: "127.0.0.1", port: 3101, strictPort: true, fs: { allow: [path.resolve(__dirname, "../..")] } },
});
