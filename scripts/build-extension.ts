import process from 'node:process'
import { resolve } from 'node:path'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, FileSystem, Schema } from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import packageJson from '../package.json' with { type: 'json' }
import { omitUndefined } from '../src/lib/omit-undefined.js'
import { resolveWorkingSetBuildSelection } from './working-set-benchmark-build-config.js'
import { createExtensionManifest } from '../src/extension/manifest.js'
import { createIndexHtml } from '../src/index-html.js'

type BuildEntry = 'app' | 'background'

const repositoryRoot = resolve(import.meta.dirname, '..')
const extensionPackageDirectory = resolveWorkingSetBuildSelection(
  repositoryRoot,
).extensionDirectory

class ExtensionBuildError extends Schema.TaggedError<ExtensionBuildError>()(
  'ExtensionBuildError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
    exitCode: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `${this.operation}: ${detail}`
  }
}

function extensionBuildError(
  operation: string,
  cause: unknown,
  exitCode?: number,
): ExtensionBuildError {
  return ExtensionBuildError.make({
    operation,
    cause,
    ...omitUndefined({ exitCode }),
  })
}

const writeGeneratedExtensionFiles = Effect.fn('extensionBuild.writeGeneratedFiles')(function* () {
  if (typeof packageJson.version !== 'string' || !packageJson.version) {
    return yield* Effect.fail(extensionBuildError(
      'read package version',
      new Error('package.json must define a string version for extension/manifest.json'),
    ))
  }

  const manifest = yield* Effect.try({
    try: () => createExtensionManifest({ version: packageJson.version }),
    catch: (cause) => extensionBuildError('create extension manifest', cause),
  })
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.writeFileString(
    resolve(extensionPackageDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ).pipe(
    Effect.mapError((cause) => extensionBuildError('write generated extension manifest', cause)),
  )
  const indexHtml = yield* Effect.tryPromise({
    try: () => createIndexHtml(),
    catch: (cause) => extensionBuildError('create dashboard page', cause),
  })
  yield* fileSystem.writeFileString(
    resolve(extensionPackageDirectory, 'index.html'),
    indexHtml,
  ).pipe(
    Effect.mapError((cause) => extensionBuildError('write generated dashboard page', cause)),
  )
})

const runBuild = Effect.fn('extensionBuild.runVite')(function* (
  entry: BuildEntry,
  viteArgs: readonly string[],
) {
  const handle = yield* ChildProcess.make('pnpm', ['exec', 'vite', 'build', ...viteArgs], {
    env: { TAB_OUT_BUILD_ENTRY: entry },
    extendEnv: true,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    shell: process.platform === 'win32',
  }).pipe(
    Effect.mapError((cause) => extensionBuildError(`start Vite ${entry} build`, cause)),
  )
  const exitCode = yield* handle.exitCode.pipe(
    Effect.mapError((cause) => extensionBuildError(`wait for Vite ${entry} build`, cause)),
  )

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(extensionBuildError(
      `run Vite ${entry} build`,
      new Error(`Vite ${entry} build exited with code ${exitCode}`),
      exitCode,
    ))
  }
})

const runExtensionBuild = Effect.fn('extensionBuild.run')(function* (viteArgs: readonly string[]) {
  yield* writeGeneratedExtensionFiles()
  yield* runBuild('app', viteArgs)
  yield* runBuild('background', viteArgs)
})

runExtensionBuild(process.argv.slice(2)).pipe(
  Effect.scoped,
  Effect.catchTag('ExtensionBuildError', (error) => error.exitCode === undefined
    ? Effect.fail(error)
    : Effect.sync(() => {
        process.exitCode = error.exitCode
      })),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
