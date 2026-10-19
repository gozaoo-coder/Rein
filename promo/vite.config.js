import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 宣传视频的舞台：1920×1080、离线可跑、产物交给 render/record.mjs 逐帧截图。
 *
 * base 用相对路径：record.mjs 把 dist/ 挂在临时静态服务器根上，子路径也能跑。
 * fs.allow 开到上一级：brand.css 直接 @import 真源的 src/styles/tokens.css，
 * 与 App 共用同一份设计令牌（这是「看起来从 App 里长出来」的手段，不是模仿）。
 */
export default defineConfig({
  base: './',
  server: {
    port: 5176,
    strictPort: true,
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tokens': fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
    },
  },
})
