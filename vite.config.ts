import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

const buildEntry = process.env.TAB_OUT_BUILD_ENTRY
const buildInputs: Record<string, string> =
  buildEntry === 'app'
    ? {
        app: resolve(__dirname, 'src/app.tsx'),
        'filter-focus-boot': resolve(__dirname, 'src/extension/filter-focus-boot.ts')
      }
    : buildEntry === 'background'
      ? { background: resolve(__dirname, 'src/extension/background.ts') }
      : {
          app: resolve(__dirname, 'src/app.tsx'),
          background: resolve(__dirname, 'src/extension/background.ts')
        }

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    target: 'esnext',
    outDir: 'extension/dist',
    emptyOutDir: buildEntry !== 'background',
    sourcemap: false,
    modulePreload: false,
    rolldownOptions: {
      input: buildInputs,
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        ...(buildEntry === 'background' ? { codeSplitting: false } : {}),
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
