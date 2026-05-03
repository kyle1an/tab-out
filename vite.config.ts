import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'extension/dist',
    emptyOutDir: true,
    sourcemap: true,
    modulePreload: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/app.tsx'),
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
