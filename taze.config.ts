import { defineConfig } from 'taze'

export default defineConfig({
  mode: 'major',
  includeLocked: true,
  githubActions: false,
  write: false,
  install: false,
  update: false,
})
