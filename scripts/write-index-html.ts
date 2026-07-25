import { writeFile } from 'node:fs/promises'

import { createIndexHtml } from '../src/index-html.js'

await writeFile(new URL('../extension/index.html', import.meta.url), await createIndexHtml())
