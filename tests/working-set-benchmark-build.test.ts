import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  assertTrackedExtensionHashUnchanged,
  WORKING_SET_BENCHMARK_BUILD_SIDECAR,
  WORKING_SET_BENCHMARK_CONTROLLER_PAGE,
  WORKING_SET_BENCHMARK_VARIANT_SIDECAR,
} from '../scripts/build-working-set-storage-benchmark.js'
import {
  assertWorkingSetBackendModuleGraph,
  resolveWorkingSetBuildSelection,
  workingSetBackgroundEntryPath,
  workingSetBenchmarkAliases,
  workingSetBenchmarkBackendModulePath,
  workingSetBenchmarkSelectorModulePath,
  workingSetProductionBackendModulePath,
  WORKING_SET_BENCHMARK_BACKEND_ENV,
  WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV,
  WORKING_SET_BENCHMARK_NONCE_ENV,
  WORKING_SET_BENCHMARK_ROOT_MARKER,
  WORKING_SET_BENCHMARK_TEMP_PREFIX,
  WORKING_SET_BENCHMARK_VARIANTS,
  type WorkingSetBenchmarkBuildSelection,
} from '../scripts/working-set-benchmark-build-config.js'

const repositoryRoot = realpathSync(process.cwd())

function makeCurrentBenchmarkSelection(): {
  readonly selection: WorkingSetBenchmarkBuildSelection
  [Symbol.dispose](): void
} {
  const temporaryRoot = mkdtempDisposableSync(join(
    realpathSync(tmpdir()),
    WORKING_SET_BENCHMARK_TEMP_PREFIX,
  ))
  const nonce = 'benchmark-test-nonce'
  const extensionDirectory = resolve(
    temporaryRoot.path,
    'current',
    'extension',
  )
  mkdirSync(extensionDirectory, { recursive: true })
  writeFileSync(
    resolve(temporaryRoot.path, WORKING_SET_BENCHMARK_ROOT_MARKER),
    `${JSON.stringify({ schemaVersion: 1, nonce })}\n`,
  )
  const selection = resolveWorkingSetBuildSelection(repositoryRoot, {
    [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'current',
    [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: extensionDirectory,
    [WORKING_SET_BENCHMARK_NONCE_ENV]: nonce,
  })
  assert.equal(selection.mode, 'benchmark')
  return {
    selection,
    [Symbol.dispose]() {
      temporaryRoot[Symbol.dispose]()
    },
  }
}

test('normal builds retain the production Working Set paths and no benchmark aliases', () => {
  const selection = resolveWorkingSetBuildSelection(repositoryRoot, {})

  assert.deepEqual(selection, {
    mode: 'production',
    backendModulePath: resolve(
      repositoryRoot,
      'src/extension/background/working-set-activity-storage-layer.ts',
    ),
    distDirectory: resolve(repositoryRoot, 'extension/dist'),
    extensionDirectory: resolve(repositoryRoot, 'extension'),
    instrumentation: 'none',
    variant: 'current',
  })
  assert.equal(
    workingSetBackgroundEntryPath(repositoryRoot, selection),
    resolve(repositoryRoot, 'src/extension/background.ts'),
  )
  assert.deepEqual(workingSetBenchmarkAliases(selection), [])
})

test('benchmark backend paths cover exactly the four compile-time variants', () => {
  assert.deepEqual(WORKING_SET_BENCHMARK_VARIANTS, [
    'current',
    'compact',
    'shards-32',
    'idb',
  ])
  assert.equal(
    workingSetBenchmarkBackendModulePath(repositoryRoot, 'current'),
    resolve(
      repositoryRoot,
      'tests/extension/working-set-backends/current-envelope-layer.ts',
    ),
  )
  for (const [variant, filename] of [
    ['compact', 'compact-envelope-layer.ts'],
    ['shards-32', 'chrome-shards-layer.ts'],
    ['idb', 'indexed-db-layer.ts'],
  ] as const) {
    assert.equal(
      workingSetBenchmarkBackendModulePath(repositoryRoot, variant),
      resolve(
        repositoryRoot,
        `tests/extension/working-set-backends/${filename}`,
      ),
    )
  }
})

test('current benchmark backend freezes the legacy envelope independently of production', () => {
  const currentBackendSource = readFileSync(
    workingSetBenchmarkBackendModulePath(repositoryRoot, 'current'),
    'utf8',
  )

  assert.doesNotMatch(
    currentBackendSource,
    /working-set-activity-storage-layer/,
  )
  assert.match(currentBackendSource, /WorkingSetActivityStorage\.layer\(/)
  assert.match(currentBackendSource, /readChromeStorageValue\(/)
  assert.match(currentBackendSource, /writeChromeStorageValue\(/)
})

test('benchmark selection requires a marked mkdtemp path and a complete environment', () => {
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'current',
    }),
    /must be supplied together/,
  )
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'unknown',
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: 'relative/extension',
      [WORKING_SET_BENCHMARK_NONCE_ENV]: 'nonce',
    }),
    /Unknown Working Set benchmark backend/,
  )
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'current',
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: 'relative/extension',
      [WORKING_SET_BENCHMARK_NONCE_ENV]: 'nonce',
    }),
    /must be absolute/,
  )

  using unmarkedRoot = mkdtempDisposableSync(join(
    realpathSync(tmpdir()),
    WORKING_SET_BENCHMARK_TEMP_PREFIX,
  ))
  const unmarkedExtension = resolve(unmarkedRoot.path, 'current', 'extension')
  mkdirSync(unmarkedExtension, { recursive: true })
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'current',
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: unmarkedExtension,
      [WORKING_SET_BENCHMARK_NONCE_ENV]: 'nonce',
    }),
    /has no marker/,
  )
  writeFileSync(
    resolve(unmarkedRoot.path, WORKING_SET_BENCHMARK_ROOT_MARKER),
    `${JSON.stringify({ schemaVersion: 1, nonce: 'expected' })}\n`,
  )
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'current',
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: unmarkedExtension,
      [WORKING_SET_BENCHMARK_NONCE_ENV]: 'different',
    }),
    /marker does not match/,
  )
  assert.throws(
    () => resolveWorkingSetBuildSelection(repositoryRoot, {
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: 'compact',
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: unmarkedExtension,
      [WORKING_SET_BENCHMARK_NONCE_ENV]: 'expected',
    }),
    /not a validated mkdtemp variant directory/,
  )
})

test('benchmark aliases bind both permitted seams to one selected backend', () => {
  using benchmark = makeCurrentBenchmarkSelection()
  const aliases = workingSetBenchmarkAliases(benchmark.selection)

  assert.equal(aliases.length, 2)
  assert.equal(aliases[0]?.replacement, benchmark.selection.backendModulePath)
  assert.equal(aliases[1]?.replacement, benchmark.selection.backendModulePath)
  assert.equal(aliases[0]?.find.test('./working-set-activity-storage-layer.js'), true)
  assert.equal(aliases[1]?.find.test('./working-set-backends/selected.js'), true)
  assert.equal(
    workingSetBackgroundEntryPath(repositoryRoot, benchmark.selection),
    resolve(
      repositoryRoot,
      'tests/extension/working-set-storage-benchmark-background.ts',
    ),
  )
})

test('module graph guard accepts only the selected backend', () => {
  using benchmark = makeCurrentBenchmarkSelection()
  const selection = benchmark.selection
  const selectedBackend = selection.backendModulePath
  const productionBackend = workingSetProductionBackendModulePath(repositoryRoot)
  const otherBackend = workingSetBenchmarkBackendModulePath(
    repositoryRoot,
    'compact',
  )

  assert.deepEqual(
    assertWorkingSetBackendModuleGraph(
      selection,
      repositoryRoot,
      ['/virtual/unowned.ts', `${selectedBackend}?used`],
    ),
    [selectedBackend],
  )
  assert.throws(
    () => assertWorkingSetBackendModuleGraph(
      selection,
      repositoryRoot,
      ['/virtual/unowned.ts'],
    ),
    /exactly its selected backend/,
  )
  assert.throws(
    () => assertWorkingSetBackendModuleGraph(
      selection,
      repositoryRoot,
      [selectedBackend, otherBackend],
    ),
    /exactly its selected backend/,
  )
  assert.throws(
    () => assertWorkingSetBackendModuleGraph(
      selection,
      repositoryRoot,
      [selectedBackend, productionBackend],
    ),
    /must exclude the production storage layer/,
  )
  assert.throws(
    () => assertWorkingSetBackendModuleGraph(
      selection,
      repositoryRoot,
      [selectedBackend, workingSetBenchmarkSelectorModulePath(repositoryRoot)],
    ),
    /selector shim was not replaced/,
  )
})

test('builder contract keeps controllers and hash sidecars outside production output', () => {
  const builderSource = readFileSync(resolve(
    repositoryRoot,
    'scripts/build-working-set-storage-benchmark.ts',
  ), 'utf8')
  const installedExtensionSource = readFileSync(resolve(
    repositoryRoot,
    'tests/extension/installed-extension.ts',
  ), 'utf8')
  const normalBackgroundBundle = readFileSync(
    resolve(repositoryRoot, 'extension/dist/background.js'),
    'utf8',
  )

  assert.equal(
    WORKING_SET_BENCHMARK_CONTROLLER_PAGE,
    'working-set-benchmark-controller.html',
  )
  assert.equal(
    WORKING_SET_BENCHMARK_BUILD_SIDECAR,
    'working-set-storage-benchmark-build.json',
  )
  assert.equal(
    WORKING_SET_BENCHMARK_VARIANT_SIDECAR,
    'working-set-storage-benchmark-artifact.json',
  )
  assert.equal(
    normalBackgroundBundle.includes('working-set-backends/selected'),
    false,
  )
  assert.equal(
    normalBackgroundBundle.includes(
      '__TAB_OUT_WORKING_SET_STORAGE_BENCHMARK__',
    ),
    false,
    'normal background bundle must omit the benchmark protocol sentinel',
  )
  assert.equal(
    builderSource.includes('<script'),
    false,
  )
  assert.match(builderSource, /tests\/helpers\/working-set-storage-profile\.ts/)
  assert.match(builderSource, /cliArguments\[0\] === '--retain'/)
  assert.match(builderSource, /try: result\.dispose/)
  assert.match(builderSource, /\[Symbol\.asyncDispose\]: dispose/)
  assert.match(
    installedExtensionSource,
    /export async function launchInstalledExtensionFromArtifact/,
  )
  assert.match(
    installedExtensionSource,
    /launchInstalledExtensionFromArtifact\(\s*builtExtensionDirectory/,
  )
  assertTrackedExtensionHashUnchanged('same-hash', 'same-hash')
  assert.throws(
    () => assertTrackedExtensionHashUnchanged('before', 'after'),
    /Tracked extension files changed/,
  )
})
