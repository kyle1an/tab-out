import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
    outDir: 'extension/dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    rolldownOptions: {
      input: resolve(__dirname, 'src/app.tsx'),
      output: {
        entryFileNames: 'app.js',
        assetFileNames: 'assets/[name][extname]',
        codeSplitting: false
      }
    }
  }
})
