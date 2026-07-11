import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    rollupOptions: {
      // plugin-os 为可选运行时依赖（未安装时 useDevice 降级到 UA 推断），
      // 标记为 external 避免 Rollup 静态解析失败。
      external: ["@tauri-apps/plugin-os"],
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@earendil-works/pi-ai")) return "pi-ai";
          if (id.includes("node_modules/@earendil-works/pi-agent-core")) return "pi-agent";
          if (id.includes("node_modules/marked")) return "vendor-marked";
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
