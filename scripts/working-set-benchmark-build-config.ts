import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'

import { Schema } from 'effect'
import type { Plugin } from 'vite'

export const WORKING_SET_BENCHMARK_BACKEND_ENV =
  'TAB_OUT_WORKING_SET_BENCHMARK_BACKEND'
export const WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV =
  'TAB_OUT_WORKING_SET_BENCHMARK_EXTENSION_DIR'
export const WORKING_SET_BENCHMARK_NONCE_ENV =
  'TAB_OUT_WORKING_SET_BENCHMARK_NONCE'
export const WORKING_SET_BENCHMARK_TEMP_PREFIX =
  'tab-out-working-set-benchmark-'
export const WORKING_SET_BENCHMARK_ROOT_MARKER =
  '.tab-out-working-set-benchmark-root.json'
export const WORKING_SET_BENCHMARK_MODULE_GRAPH =
  'working-set-backend-module-graph.json'

const workingSetBenchmarkVariantSchema = Schema.Literals([
  'current',
  'compact',
  'shards-32',
  'idb'
])

export type WorkingSetBenchmarkVariant =
  typeof workingSetBenchmarkVariantSchema.Type

export const WORKING_SET_BENCHMARK_VARIANTS: readonly WorkingSetBenchmarkVariant[] = [
  'current',
  'compact',
  'shards-32',
  'idb'
]

export const workingSetBenchmarkInstrumentationSchema = Schema.Literals([
  'none'
])

export type WorkingSetBenchmarkInstrumentation =
  typeof workingSetBenchmarkInstrumentationSchema.Type

const workingSetBenchmarkCandidateFilename: Readonly<
  Record<WorkingSetBenchmarkVariant, string>
> = {
  current: 'current-envelope-layer.ts',
  compact: 'compact-envelope-layer.ts',
  'shards-32': 'chrome-shards-layer.ts',
  idb: 'indexed-db-layer.ts'
}

const isWorkingSetBenchmarkVariant = Schema.is(
  workingSetBenchmarkVariantSchema
)

const workingSetBenchmarkRootMarkerSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  nonce: Schema.String
})
const isWorkingSetBenchmarkRootMarker = Schema.is(
  workingSetBenchmarkRootMarkerSchema
)

export type WorkingSetProductionBuildSelection = {
  readonly mode: 'production'
  readonly backendModulePath: string
  readonly distDirectory: string
  readonly extensionDirectory: string
  readonly instrumentation: 'none'
  readonly variant: 'current'
}

export type WorkingSetBenchmarkBuildSelection = {
  readonly mode: 'benchmark'
  readonly backendModulePath: string
  readonly benchmarkRoot: string
  readonly distDirectory: string
  readonly extensionDirectory: string
  readonly instrumentation: WorkingSetBenchmarkInstrumentation
  readonly moduleGraphPath: string
  readonly variant: WorkingSetBenchmarkVariant
}

export type WorkingSetBuildSelection =
  | WorkingSetProductionBuildSelection
  | WorkingSetBenchmarkBuildSelection

function pathIsInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  )
}

export function workingSetProductionBackendModulePath(
  repositoryRoot: string
): string {
  return resolve(
    repositoryRoot,
    'src/extension/background/working-set-activity-storage-layer.ts'
  )
}

export function workingSetBenchmarkBackendModulePath(
  repositoryRoot: string,
  variant: WorkingSetBenchmarkVariant
): string {
  return resolve(
    repositoryRoot,
    'tests/extension/working-set-backends',
    workingSetBenchmarkCandidateFilename[variant]
  )
}

export function workingSetOwnedBackendModulePaths(
  repositoryRoot: string
): readonly string[] {
  return WORKING_SET_BENCHMARK_VARIANTS.map((variant) =>
    workingSetBenchmarkBackendModulePath(repositoryRoot, variant)
  )
}

export function workingSetBenchmarkSelectorModulePath(
  repositoryRoot: string
): string {
  return resolve(
    repositoryRoot,
    'tests/extension/working-set-backends/selected.ts'
  )
}

export function workingSetBackgroundEntryPath(
  repositoryRoot: string,
  selection: WorkingSetBuildSelection
): string {
  return selection.mode === 'production'
    ? resolve(repositoryRoot, 'src/extension/background.ts')
    : resolve(
        repositoryRoot,
        'tests/extension/working-set-storage-benchmark-background.ts'
      )
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = environment[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readBenchmarkRootMarker(root: string): unknown {
  const markerPath = join(root, WORKING_SET_BENCHMARK_ROOT_MARKER)
  if (!existsSync(markerPath)) {
    throw new Error(`Working Set benchmark root has no marker: ${markerPath}`)
  }
  return JSON.parse(readFileSync(markerPath, 'utf8'))
}

export function resolveWorkingSetBuildSelection(
  repositoryRootInput: string,
  environment: NodeJS.ProcessEnv = process.env
): WorkingSetBuildSelection {
  const repositoryRoot = realpathSync(repositoryRootInput)
  const backend = requiredEnvironmentValue(
    environment,
    WORKING_SET_BENCHMARK_BACKEND_ENV
  )
  const extensionDirectoryInput = requiredEnvironmentValue(
    environment,
    WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV
  )
  const nonce = requiredEnvironmentValue(
    environment,
    WORKING_SET_BENCHMARK_NONCE_ENV
  )
  const benchmarkEnvironmentValues = [backend, extensionDirectoryInput, nonce]
  const suppliedValues = benchmarkEnvironmentValues.filter(
    (value) => value !== undefined
  ).length

  if (suppliedValues === 0) {
    const extensionDirectory = resolve(repositoryRoot, 'extension')
    return {
      mode: 'production',
      backendModulePath: workingSetProductionBackendModulePath(repositoryRoot),
      distDirectory: resolve(extensionDirectory, 'dist'),
      extensionDirectory,
      instrumentation: 'none',
      variant: 'current'
    }
  }
  if (suppliedValues !== benchmarkEnvironmentValues.length) {
    throw new Error(
      'Working Set benchmark backend, extension directory, and nonce must be supplied together'
    )
  }
  if (!isWorkingSetBenchmarkVariant(backend)) {
    throw new Error(`Unknown Working Set benchmark backend: ${String(backend)}`)
  }
  if (extensionDirectoryInput === undefined || nonce === undefined) {
    throw new Error('Working Set benchmark environment is incomplete')
  }
  if (!isAbsolute(extensionDirectoryInput)) {
    throw new Error('Working Set benchmark extension directory must be absolute')
  }

  const extensionDirectory = realpathSync(extensionDirectoryInput)
  const variantDirectory = dirname(extensionDirectory)
  const benchmarkRoot = dirname(variantDirectory)
  const expectedTemporaryParent = realpathSync(tmpdir())
  if (
    basename(extensionDirectory) !== 'extension' ||
    basename(variantDirectory) !== backend ||
    dirname(benchmarkRoot) !== expectedTemporaryParent ||
    !basename(benchmarkRoot).startsWith(WORKING_SET_BENCHMARK_TEMP_PREFIX)
  ) {
    throw new Error(
      `Working Set benchmark output is not a validated mkdtemp variant directory: ${extensionDirectory}`
    )
  }
  if (pathIsInside(repositoryRoot, extensionDirectory)) {
    throw new Error('Working Set benchmark output must stay outside the repository')
  }

  const marker = readBenchmarkRootMarker(benchmarkRoot)
  if (!isWorkingSetBenchmarkRootMarker(marker) || marker.nonce !== nonce) {
    throw new Error('Working Set benchmark root marker does not match the build nonce')
  }

  const backendModulePath = workingSetBenchmarkBackendModulePath(
    repositoryRoot,
    backend
  )
  if (!existsSync(backendModulePath)) {
    throw new Error(
      `Working Set benchmark backend module does not exist: ${backendModulePath}`
    )
  }

  return {
    mode: 'benchmark',
    backendModulePath,
    benchmarkRoot,
    distDirectory: resolve(extensionDirectory, 'dist'),
    extensionDirectory,
    instrumentation: 'none',
    moduleGraphPath: resolve(
      variantDirectory,
      WORKING_SET_BENCHMARK_MODULE_GRAPH
    ),
    variant: backend
  }
}

function normalizedModuleId(moduleId: string): string {
  const queryStart = moduleId.indexOf('?')
  return resolve(queryStart === -1 ? moduleId : moduleId.slice(0, queryStart))
}

export function assertWorkingSetBackendModuleGraph(
  selection: WorkingSetBenchmarkBuildSelection,
  repositoryRoot: string,
  moduleIds: readonly string[]
): readonly string[] {
  const ownedModules = new Set(
    workingSetOwnedBackendModulePaths(repositoryRoot).map(normalizedModuleId)
  )
  const includedBackendModules = [...new Set(
    moduleIds
      .map(normalizedModuleId)
      .filter((moduleId) => ownedModules.has(moduleId))
  )].sort()
  const selectedBackendModule = normalizedModuleId(selection.backendModulePath)
  const includedModuleIds = new Set(moduleIds.map(normalizedModuleId))
  if (
    includedBackendModules.length !== 1 ||
    includedBackendModules[0] !== selectedBackendModule
  ) {
    throw new Error(
      'Working Set benchmark bundle must contain exactly its selected backend ' +
      `(selected=${selectedBackendModule}, included=${includedBackendModules.join(',')})`
    )
  }
  const selectorModule = normalizedModuleId(
    workingSetBenchmarkSelectorModulePath(repositoryRoot)
  )
  if (includedModuleIds.has(selectorModule)) {
    throw new Error(
      `Working Set benchmark selector shim was not replaced: ${selectorModule}`
    )
  }
  const productionBackendModule = normalizedModuleId(
    workingSetProductionBackendModulePath(repositoryRoot)
  )
  const productionBackendIncluded = includedModuleIds.has(
    productionBackendModule
  )
  if (productionBackendIncluded) {
    throw new Error(
      'Working Set benchmark bundle must exclude the production storage layer ' +
      `(variant=${selection.variant}, module=${productionBackendModule})`
    )
  }
  return includedBackendModules
}

export function workingSetBenchmarkAliases(
  selection: WorkingSetBuildSelection
): readonly { readonly find: RegExp; readonly replacement: string }[] {
  if (selection.mode === 'production') return []
  return [
    {
      find: /^\.\/working-set-activity-storage-layer\.js$/,
      replacement: selection.backendModulePath
    },
    {
      find: /^\.\/working-set-backends\/selected\.js$/,
      replacement: selection.backendModulePath
    }
  ]
}

export function workingSetBenchmarkModuleGraphPlugin(
  selection: WorkingSetBuildSelection,
  repositoryRoot: string
): Plugin | null {
  if (selection.mode === 'production') return null
  return {
    name: 'tab-out-working-set-benchmark-module-graph',
    generateBundle(_outputOptions, bundle) {
      const moduleIds = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? Object.keys(output.modules) : []
      )
      const includedBackendModules = assertWorkingSetBackendModuleGraph(
        selection,
        repositoryRoot,
        moduleIds
      )
      writeFileSync(
        selection.moduleGraphPath,
        `${JSON.stringify({
          schemaVersion: 1,
          variant: selection.variant,
          instrumentation: selection.instrumentation,
          selectedBackendModule: selection.backendModulePath,
          includedBackendModules,
          moduleIds: [...new Set(moduleIds)].sort()
        }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
    }
  }
}
