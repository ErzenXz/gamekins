import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Electron 44 ships Chromium 14x / Node 24: no need to down-level anything.
const CHROME_TARGET = 'chrome140'

// Compiled into every process; a packaged Store build cannot be downgraded at runtime.
const distributionDefine = {
  __GAMEKINS_STORE__: JSON.stringify(process.env.GAMEKINS_DISTRIBUTION === 'ms-store')
}

export default defineConfig({
  main: {
    define: distributionDefine,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { target: 'node22', minify: true, reportCompressedSize: false }
  },
  preload: {
    define: distributionDefine,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { target: 'node22', minify: true, reportCompressedSize: false }
  },
  renderer: {
    define: distributionDefine,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      target: CHROME_TARGET,
      minify: 'esbuild',
      cssMinify: true,
      cssCodeSplit: true,
      reportCompressedSize: false,
      // Assets are read from disk: inlining small images only bloats the JS.
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          // React rarely changes: keep it in its own chunk.
          manualChunks: { react: ['react', 'react-dom', 'react/jsx-runtime', 'zustand'] }
        }
      }
    }
  }
})
