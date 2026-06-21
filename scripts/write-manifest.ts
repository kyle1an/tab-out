import { readFile, writeFile } from 'node:fs/promises'

import { createExtensionManifest } from '../src/extension/manifest.js'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('package.json must define a string version for extension/manifest.json')
}

const manifest = createExtensionManifest({ version: packageJson.version })
await writeFile(new URL('../extension/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
