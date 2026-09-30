import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { localRuntimePlugin } from './localRuntime.js'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [localRuntimePlugin(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    // 构建时间戳(东八区): 注入 bundle, StatusBar 显示, 用于确认线上运行的是哪次构建
    __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })),
  },
  server: {
    watch: {
      ignored: ['**/.flowboard-release/**', '**/dist/**', '**/node_modules/**', '**/*.exe', '**/sea-prep.blob'],
    },
  },
})
