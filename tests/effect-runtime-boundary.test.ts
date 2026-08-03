import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repositoryRoot, 'src')
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx'])

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return productionTypeScriptFiles(path)
      return entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name)) ? [path] : []
    })
    .sort()
}

test('production Effects cross the runtime boundary only through the shared app and worker runtimes', () => {
  const sources = productionTypeScriptFiles(sourceRoot).map((path) => ({
    path,
    relativePath: relative(repositoryRoot, path),
    source: readFileSync(path, 'utf8')
  }))

  const managedRuntimeOwners = sources
    .filter(({ source }) => /\bManagedRuntime\.make\(/.test(source))
    .map(({ relativePath }) => relativePath)

  assert.deepEqual(managedRuntimeOwners, [
    'src/extension/app-runtime.ts',
    'src/extension/background/runtime.ts'
  ])

  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(
      source,
      /\bEffect\.run(?:Callback|Fork|Promise(?:Exit)?|Sync(?:Exit)?)\b/,
      `${relativePath} must use its entrypoint's shared ManagedRuntime`
    )
  }
})
