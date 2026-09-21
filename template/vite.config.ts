import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * Tauri 桌面外壳按 src-tauri/tauri.conf.json 里的 build.devUrl 找前端，
 * 所以端口必须固定 —— 端口一变，桌面窗口就白屏。
 * strictPort 让端口被占时直接报错，而不是悄悄换一个能启动、但桌面端连不上的端口。
 */
export default defineConfig({
  plugins: [react()],
  // Tauri 的日志要和前端日志混在一个终端里看，别让 Vite 清屏把它们冲掉
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    // src-tauri/ 一改就会触发 Rust 重编，让 Vite 别去 watch 它
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 就是 Chromium，目标按它的版本定即可，不必迁就旧浏览器
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
});
