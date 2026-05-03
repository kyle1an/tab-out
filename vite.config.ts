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
      input: {
        app: resolve(__dirname, 'src/app.tsx'),
        background: resolve(__dirname, 'src/extension/background.js')
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
