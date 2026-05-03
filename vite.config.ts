import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
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
