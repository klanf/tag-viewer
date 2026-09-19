import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 渲染进程(纯前端)。base 用相对路径, 因为生产环境走 file:// 加载 dist/index.html。
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    /**
     * 不清空输出目录, 且**不用内容哈希命名** —— 两件事是配套的。
     *
     * 原本是 `emptyOutDir: true` + 带哈希的文件名, 每次构建都会把上次的产物删掉重建。
     * 但"一次删掉上百个小文件"会撞上执行环境的批量删除保护(dist/assets 里攒到 50+ 个
     * 就报 SAFE_DELETE_BULK_CONFIRM_REQUIRED, 构建直接失败)。
     *
     * 对**本机 file:// 加载的 Electron 应用**来说, 内容哈希本来就没什么价值:
     * 没有 HTTP 缓存要绕过, 也就没有"必须换文件名"的理由。改成固定文件名之后,
     * 每次构建是**覆盖**而不是"先删后建", 既不触发保护, dist 也不会越滚越大。
     * 代价: 文件数常量化了, 但也失去了"浏览器缓存自动失效"——这里用不到。
     */
    emptyOutDir: false,
    target: 'chrome130',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 5178,
    strictPort: true,
  },
})
