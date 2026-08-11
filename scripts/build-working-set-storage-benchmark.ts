import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  cp,
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect, Schema } from 'effect'

import {
  assertWorkingSetBackendModuleGraph,
  resolveWorkingSetBuildSelection,
  workingSetBenchmarkBackendModulePath,
  workingSetBenchmarkSelectorModulePath,
  WORKING_SET_BENCHMARK_BACKEND_ENV,
  WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV,
  WORKING_SET_BENCHMARK_NONCE_ENV,
  WORKING_SET_BENCHMARK_ROOT_MARKER,
  WORKING_SET_BENCHMARK_TEMP_PREFIX,
  WORKING_SET_BENCHMARK_VARIANTS,
  type WorkingSetBenchmarkBuildSelection,
  type WorkingSetBenchmarkVariant,
} from './working-set-benchmark-build-config.ts'

export const WORKING_SET_BENCHMARK_BUILD_SIDECAR =
  'working-set-storage-benchmark-build.json'
export const WORKING_SET_BENCHMARK_VARIANT_SIDECAR =
  'working-set-storage-benchmark-artifact.json'
export const WORKING_SET_BENCHMARK_CONTROLLER_PAGE =
  'working-set-benchmark-controller.html'
const WORKING_SET_BENCHMARK_SENTINEL =
  '__TAB_OUT_WORKING_SET_STORAGE_BENCHMARK__'

const controllerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Working Set storage benchmark controller</title>
  </head>
  <body></body>
</html>
`

const generatedExtensionEntries = new Set([
  'dist',
  'index.html',
  'manifest.json',
  WORKING_SET_BENCHMARK_CONTROLLER_PAGE,
])

const moduleGraphSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  variant: Schema.Literals(WORKING_SET_BENCHMARK_VARIANTS),
  instrumentation: Schema.Literals(['none']),
  selectedBackendModule: Schema.String,
  includedBackendModules: Schema.Array(Schema.String),
  moduleIds: Schema.Array(Schema.String),
})
const isModuleGraph = Schema.is(moduleGraphSchema)

export interface WorkingSetBenchmarkArtifactHashes {
  readonly artifactTreeSha256: string
  readonly backendModuleGraphSha256: string
  readonly backgroundBundleSha256: string
  readonly lockfileSha256: string
  readonly selectedBackendModuleSha256: string
  readonly workloadFixtureSha256: string
}

export interface WorkingSetBenchmarkArtifactSidecar {
  readonly schemaVersion: 1
  readonly variant: WorkingSetBenchmarkVariant
  readonly instrumentation: 'none'
  readonly extensionDirectory: string
  readonly controllerPage: string
  readonly moduleGraphPath: string
  readonly selectedBackendModule: string
  readonly hashes: WorkingSetBenchmarkArtifactHashes
}

export interface WorkingSetBenchmarkBuildSidecar {
  readonly schemaVersion: 1
  readonly benchmarkRoot: string
  readonly buildNonce: string
  readonly createdAt: string
  readonly instrumentation: 'none'
  readonly trackedExtension: {
    readonly beforeSha256: string
    readonly afterSha256: string
  }
  readonly variants: readonly WorkingSetBenchmarkArtifactSidecar[]
}

export interface WorkingSetBenchmarkBuildResult extends AsyncDisposable {
  readonly sidecar: WorkingSetBenchmarkBuildSidecar
  readonly sidecarPath: string
  readonly dispose: () => Promise<void>
}

class WorkingSetBenchmarkBuildError extends Schema.TaggedError<WorkingSetBenchmarkBuildError>()(
  'WorkingSetBenchmarkBuildError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error
      ? this.cause.message
      : String(this.cause)
    return `${this.operation}: ${detail}`
  }
}

function benchmarkBuildError(
  operation: string,
  cause: unknown,
): WorkingSetBenchmarkBuildError {
  return WorkingSetBenchmarkBuildError.make({ operation, cause })
}

function relativePathWithin(root: string, path: string): string {
  const pathFromRoot = relative(root, path)
  if (
    pathFromRoot === '' ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`Path is not a file below ${root}: ${path}`)
  }
  return pathFromRoot
}

function updateHashWithPath(hash: ReturnType<typeof createHash>, path: string): void {
  hash.update(String(Buffer.byteLength(path)))
  hash.update(':')
  hash.update(path)
  hash.update('\0')
}

async function listTreeEntries(root: string): Promise<readonly string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => {
      const leftParts = relative(root, left).split(sep)
      const rightParts = relative(root, right).split(sep)
      const sharedLength = Math.min(leftParts.length, rightParts.length)
      for (let index = 0; index < sharedLength; index += 1) {
        const order = (leftParts[index] ?? '').localeCompare(rightParts[index] ?? '')
        if (order !== 0) return order
      }
      return leftParts.length - rightParts.length
    })
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function sha256Directory(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const path of await listTreeEntries(root)) {
    const pathFromRoot = relativePathWithin(root, path)
    updateHashWithPath(hash, pathFromRoot)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      hash.update('link\0')
      hash.update(await readlink(path))
    } else {
      hash.update('file\0')
      hash.update(await readFile(path))
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function trackedExtensionSha256(repositoryRoot: string): Promise<string> {
  const listedFiles = trackedExtensionRepositoryPaths(repositoryRoot)
  const hash = createHash('sha256')
  for (const repositoryPath of listedFiles) {
    updateHashWithPath(hash, repositoryPath)
    hash.update(await readFile(resolve(repositoryRoot, repositoryPath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function trackedExtensionRepositoryPaths(
  repositoryRoot: string,
): readonly string[] {
  const listedFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'extension'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).split('\0').filter((path) => path.length > 0).sort()
  if (listedFiles.length === 0) {
    throw new Error('Git reported no tracked extension files')
  }
  return listedFiles
}

export function assertTrackedExtensionHashUnchanged(
  beforeSha256: string,
  afterSha256: string,
): void {
  if (beforeSha256 !== afterSha256) {
    throw new Error(
      'Tracked extension files changed during the disposable benchmark build ' +
      `(before=${beforeSha256}, after=${afterSha256})`,
    )
  }
}

async function copyExtensionScaffold(
  repositoryRoot: string,
  sourceDirectory: string,
  targetDirectory: string,
): Promise<void> {
  const trackedExtensionRoot = resolve(repositoryRoot, 'extension')
  const trackedStaticFiles = trackedExtensionRepositoryPaths(repositoryRoot)
    .map((path) => relative(
      trackedExtensionRoot,
      resolve(repositoryRoot, path),
    ))
    .filter((path) => !generatedExtensionEntries.has(path.split(sep)[0] ?? ''))
  await cp(sourceDirectory, targetDirectory, {
    errorOnExist: true,
    force: false,
    recursive: true,
    filter(source) {
      const sourceRelativePath = relative(sourceDirectory, source)
      if (sourceRelativePath === '') return true
      const firstPathSegment = sourceRelativePath.split(sep)[0]
      if (
        firstPathSegment === undefined ||
        generatedExtensionEntries.has(firstPathSegment)
      ) return false
      return trackedStaticFiles.some((trackedPath) =>
        trackedPath === sourceRelativePath ||
        trackedPath.startsWith(`${sourceRelativePath}${sep}`),
      )
    },
  })
}

async function runExtensionBuild(
  repositoryRoot: string,
  selection: WorkingSetBenchmarkBuildSelection,
  nonce: string,
): Promise<void> {
  const child = spawn(process.execPath, [
    '--experimental-import-text',
    '--import',
    'tsx',
    resolve(repositoryRoot, 'scripts/build-extension.ts'),
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      [WORKING_SET_BENCHMARK_BACKEND_ENV]: selection.variant,
      [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: selection.extensionDirectory,
      [WORKING_SET_BENCHMARK_NONCE_ENV]: nonce,
    },
    stdio: 'inherit',
  })

  const [code, signal] = await once(child, 'exit')
  if (code === 0) return
  throw new Error(
    signal === null
      ? `Extension build exited with code ${String(code)}`
      : `Extension build exited after signal ${signal}`,
  )
}

async function readAndValidateModuleGraph(
  selection: WorkingSetBenchmarkBuildSelection,
  repositoryRoot: string,
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(selection.moduleGraphPath, 'utf8'))
  if (!isModuleGraph(parsed)) {
    throw new Error(`Invalid benchmark module graph: ${selection.moduleGraphPath}`)
  }
  if (
    parsed.variant !== selection.variant ||
    parsed.instrumentation !== 'none' ||
    parsed.selectedBackendModule !== selection.backendModulePath
  ) {
    throw new Error(
      `Benchmark module graph does not describe ${selection.variant}`,
    )
  }
  assertWorkingSetBackendModuleGraph(
    selection,
    repositoryRoot,
    parsed.moduleIds,
  )
}

async function buildVariant(
  repositoryRoot: string,
  benchmarkRoot: string,
  nonce: string,
  variant: WorkingSetBenchmarkVariant,
  commonHashes: Pick<
    WorkingSetBenchmarkArtifactHashes,
    'lockfileSha256' | 'workloadFixtureSha256'
  >,
): Promise<WorkingSetBenchmarkArtifactSidecar> {
  const variantDirectory = resolve(benchmarkRoot, variant)
  const extensionDirectory = resolve(variantDirectory, 'extension')
  await mkdir(variantDirectory)
  await copyExtensionScaffold(
    repositoryRoot,
    resolve(repositoryRoot, 'extension'),
    extensionDirectory,
  )
  await writeFile(
    resolve(extensionDirectory, WORKING_SET_BENCHMARK_CONTROLLER_PAGE),
    controllerHtml,
    { encoding: 'utf8', flag: 'wx' },
  )

  const selectionEnvironment: NodeJS.ProcessEnv = {
    [WORKING_SET_BENCHMARK_BACKEND_ENV]: variant,
    [WORKING_SET_BENCHMARK_EXTENSION_DIR_ENV]: extensionDirectory,
    [WORKING_SET_BENCHMARK_NONCE_ENV]: nonce,
  }
  const selection = resolveWorkingSetBuildSelection(
    repositoryRoot,
    selectionEnvironment,
  )
  if (selection.mode !== 'benchmark') {
    throw new Error(`Expected a benchmark build selection for ${variant}`)
  }

  await runExtensionBuild(repositoryRoot, selection, nonce)
  await readAndValidateModuleGraph(selection, repositoryRoot)
  const backgroundBundlePath = resolve(selection.distDirectory, 'background.js')
  const backgroundBundle = await readFile(backgroundBundlePath, 'utf8')
  if (!backgroundBundle.includes(WORKING_SET_BENCHMARK_SENTINEL)) {
    throw new Error(
      `Benchmark background bundle omits its protocol sentinel: ${backgroundBundlePath}`,
    )
  }

  const artifact: WorkingSetBenchmarkArtifactSidecar = {
    schemaVersion: 1,
    variant,
    instrumentation: 'none',
    extensionDirectory: selection.extensionDirectory,
    controllerPage: WORKING_SET_BENCHMARK_CONTROLLER_PAGE,
    moduleGraphPath: selection.moduleGraphPath,
    selectedBackendModule: selection.backendModulePath,
    hashes: {
      artifactTreeSha256: await sha256Directory(selection.extensionDirectory),
      backendModuleGraphSha256: await sha256File(selection.moduleGraphPath),
      backgroundBundleSha256: await sha256File(backgroundBundlePath),
      selectedBackendModuleSha256: await sha256File(selection.backendModulePath),
      ...commonHashes,
    },
  }
  await writeFile(
    resolve(variantDirectory, WORKING_SET_BENCHMARK_VARIANT_SIDECAR),
    `${JSON.stringify(artifact, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  return artifact
}

async function assertBenchmarkSourcesExist(repositoryRoot: string): Promise<void> {
  const sourcePaths = [
    resolve(
      repositoryRoot,
      'tests/extension/working-set-storage-benchmark-background.ts',
    ),
    workingSetBenchmarkSelectorModulePath(repositoryRoot),
    resolve(repositoryRoot, 'tests/helpers/working-set-storage-profile.ts'),
    ...WORKING_SET_BENCHMARK_VARIANTS.map((variant) =>
      workingSetBenchmarkBackendModulePath(repositoryRoot, variant),
    ),
  ]
  for (const sourcePath of sourcePaths) {
    const metadata = await lstat(sourcePath)
    if (!metadata.isFile()) {
      throw new Error(`Benchmark source is not a regular file: ${sourcePath}`)
    }
  }
}

async function buildWorkingSetStorageBenchmarkArtifactsUnsafe(
  repositoryRootInput: string,
): Promise<WorkingSetBenchmarkBuildResult> {
  const repositoryRoot = await realpath(repositoryRootInput)
  const trackedExtensionBefore = await trackedExtensionSha256(repositoryRoot)
  let benchmarkDirectory: Awaited<ReturnType<typeof mkdtempDisposable>> | undefined

  try {
    await assertBenchmarkSourcesExist(repositoryRoot)
    const temporaryParent = await realpath(tmpdir())
    const acquiredBenchmarkDirectory = await mkdtempDisposable(
      join(temporaryParent, WORKING_SET_BENCHMARK_TEMP_PREFIX),
    )
    benchmarkDirectory = acquiredBenchmarkDirectory
    const benchmarkRoot = acquiredBenchmarkDirectory.path
    const nonce = randomUUID()
    await writeFile(
      resolve(benchmarkRoot, WORKING_SET_BENCHMARK_ROOT_MARKER),
      `${JSON.stringify({ schemaVersion: 1, nonce }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )

    const commonHashes = {
      lockfileSha256: await sha256File(resolve(repositoryRoot, 'pnpm-lock.yaml')),
      workloadFixtureSha256: await sha256File(resolve(
        repositoryRoot,
        'tests/helpers/working-set-storage-profile.ts',
      )),
    }
    const variants: WorkingSetBenchmarkArtifactSidecar[] = []
    for (const variant of WORKING_SET_BENCHMARK_VARIANTS) {
      variants.push(await buildVariant(
        repositoryRoot,
        benchmarkRoot,
        nonce,
        variant,
        commonHashes,
      ))
    }

    const trackedExtensionAfter = await trackedExtensionSha256(repositoryRoot)
    assertTrackedExtensionHashUnchanged(
      trackedExtensionBefore,
      trackedExtensionAfter,
    )
    const sidecar: WorkingSetBenchmarkBuildSidecar = {
      schemaVersion: 1,
      benchmarkRoot,
      buildNonce: nonce,
      createdAt: new Date().toISOString(),
      instrumentation: 'none',
      trackedExtension: {
        beforeSha256: trackedExtensionBefore,
        afterSha256: trackedExtensionAfter,
      },
      variants,
    }
    const sidecarPath = resolve(
      benchmarkRoot,
      WORKING_SET_BENCHMARK_BUILD_SIDECAR,
    )
    await writeFile(
      sidecarPath,
      `${JSON.stringify(sidecar, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    const dispose = acquiredBenchmarkDirectory.remove
    return {
      sidecar,
      sidecarPath,
      dispose,
      [Symbol.asyncDispose]: dispose,
    }
  } catch (cause) {
    let extensionHashFailure: unknown
    try {
      assertTrackedExtensionHashUnchanged(
        trackedExtensionBefore,
        await trackedExtensionSha256(repositoryRoot),
      )
    } catch (hashCause) {
      extensionHashFailure = hashCause
    }
    if (benchmarkDirectory !== undefined) {
      await benchmarkDirectory.remove()
    }
    if (extensionHashFailure !== undefined) {
      throw new Error(
        `${String(extensionHashFailure)}; original build failure: ${String(cause)}`,
        { cause },
      )
    }
    throw cause
  }
}

export function buildWorkingSetStorageBenchmarkArtifacts(
  repositoryRoot = resolve(import.meta.dirname, '..'),
): Promise<WorkingSetBenchmarkBuildResult> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => buildWorkingSetStorageBenchmarkArtifactsUnsafe(repositoryRoot),
      catch: (cause) => benchmarkBuildError(
        'build disposable Working Set storage benchmark artifacts',
        cause,
      ),
    }),
  )
}

if (import.meta.main) {
  const cliArguments = process.argv.slice(2)
  const retainArtifacts = cliArguments.length === 1 &&
    cliArguments[0] === '--retain'
  const validArguments = cliArguments.length === 0 || retainArtifacts

  Effect.gen(function* () {
    if (!validArguments) {
      return yield* Effect.fail(benchmarkBuildError(
        'parse benchmark builder arguments',
        new Error('Usage: build-working-set-storage-benchmark.ts [--retain]'),
      ))
    }
    const result = yield* Effect.tryPromise({
      try: () => buildWorkingSetStorageBenchmarkArtifacts(),
      catch: (cause) => benchmarkBuildError(
        'build disposable Working Set storage benchmark artifacts',
        cause,
      ),
    })
    if (retainArtifacts) {
      yield* Effect.sync(() => console.log(result.sidecarPath))
      return
    }
    yield* Effect.tryPromise({
      try: result.dispose,
      catch: (cause) => benchmarkBuildError(
        'dispose verified Working Set benchmark artifacts',
        cause,
      ),
    })
    yield* Effect.sync(() => console.log(JSON.stringify({
      disposed: true,
      trackedExtensionSha256: result.sidecar.trackedExtension.afterSha256,
      instrumentation: result.sidecar.instrumentation,
      variants: result.sidecar.variants.map(({ variant, hashes }) => ({
        variant,
        artifactTreeSha256: hashes.artifactTreeSha256,
        backgroundBundleSha256: hashes.backgroundBundleSha256,
      })),
    }, null, 2)))
  }).pipe(
    NodeRuntime.runMain,
  )
}
