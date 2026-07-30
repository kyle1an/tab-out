import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

import packageJson from '../package.json' with { type: 'json' }
import { createExtensionManifest } from '../src/extension/manifest.js'
import { createIndexHtml } from '../src/index-html.js'

const viteArgs = process.argv.slice(2)

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('package.json must define a string version for extension/manifest.json')
}

const manifest = createExtensionManifest({ version: packageJson.version })
await writeFile(new URL('../extension/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(new URL('../extension/index.html', import.meta.url), await createIndexHtml())

function runBuild(entry: 'app' | 'background'): void {
  const result = spawnSync('pnpm', ['exec', 'vite', 'build', ...viteArgs], {
    env: { ...process.env, TAB_OUT_BUILD_ENTRY: entry },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runBuild('app')
runBuild('background')
