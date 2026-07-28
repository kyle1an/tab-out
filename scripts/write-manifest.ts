import { writeFile } from 'node:fs/promises'

import packageJson from '../package.json' with { type: 'json' }
import { createExtensionManifest } from '../src/extension/manifest.js'

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('package.json must define a string version for extension/manifest.json')
}

const manifest = createExtensionManifest({ version: packageJson.version })
await writeFile(new URL('../extension/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
