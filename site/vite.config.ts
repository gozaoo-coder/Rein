import { defineConfig } from 'vite'
import pkg from '../package.json'

// 站点要挂在 https://<user>.github.io/<repo>/ 这种子路径下，资产一律走相对路径。
// 令牌真源在仓库根的 src/styles/tokens.css，site.css 用 @import 直接引用它，
// 因此开发服务器必须被允许读到 site/ 之外的这一个文件。
export default defineConfig({
  base: './',
  server: {
    fs: { allow: ['..'] },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
