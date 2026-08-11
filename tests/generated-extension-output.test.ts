import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempDisposableSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { unstagedGeneratedEntries } from '../scripts/check-generated-extension-output.js'

const SCRIPT_FILE = join(
  import.meta.dirname,
  '../scripts/check-generated-extension-output.ts',
)
const GIT_LOCAL_ENVIRONMENT_VARIABLES = execFileSync(
  'git',
  ['rev-parse', '--local-env-vars'],
  { encoding: 'utf8' },
).trim().split(/\r?\n/u).filter(Boolean)

function independentGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of GIT_LOCAL_ENVIRONMENT_VARIABLES) delete environment[name]
  return environment
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: independentGitEnvironment(),
  }).trim()
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT_FILE], {
    cwd,
    encoding: 'utf8',
    env: independentGitEnvironment(),
  })
}

test('generated output status keeps staged entries and rejects worktree or untracked entries', () => {
  assert.deepEqual(
    unstagedGeneratedEntries([
      'M  extension/dist/app.js',
      'A  extension/dist/assets/chunk.js',
      ' M extension/index.html',
      '?? extension/dist/assets/missing.js',
      '',
    ].join('\n')),
    [
      ' M extension/index.html',
      '?? extension/dist/assets/missing.js',
    ],
  )
})

test('generated output check rejects a replacement chunk omitted from the Git index', () => {
  using temporaryRoot = mkdtempDisposableSync(join(
    tmpdir(),
    'tab-out-generated-extension-',
  ))
  const root = temporaryRoot.path
  const extension = join(root, 'extension')
  const dist = join(extension, 'dist')
  const assets = join(dist, 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(extension, 'index.html'), 'baseline html\n')
  writeFileSync(join(extension, 'manifest.json'), '{}\n')
  writeFileSync(join(dist, 'app.js'), 'baseline app\n')

  git(root, 'init')
  git(root, 'add', 'extension')
  assert.equal(runCheck(root).status, 0)

  writeFileSync(join(dist, 'app.js'), 'rebuilt app\n')
  writeFileSync(join(assets, 'replacement.js'), 'replacement chunk\n')
  git(root, 'add', '-u', 'extension')

  const missingChunk = runCheck(root)
  assert.equal(missingChunk.status, 1)
  assert.match(missingChunk.stderr, /\?\? extension\/dist\/assets\/replacement\.js/)

  git(root, 'add', 'extension/dist/assets/replacement.js')
  assert.equal(runCheck(root).status, 0)

  writeFileSync(join(extension, 'manifest.json'), '{"changed":true}\n')
  const staleManifest = runCheck(root)
  assert.equal(staleManifest.status, 1)
  assert.match(staleManifest.stderr, /AM extension\/manifest\.json/)

  writeFileSync(join(root, 'unrelated.txt'), 'outside generated output\n')
  git(root, 'add', 'extension/manifest.json')
  assert.equal(runCheck(root).status, 0)
})
