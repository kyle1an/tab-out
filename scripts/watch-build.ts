import { watch, type FSWatcher } from 'node:fs'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Schema } from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { runWatchBuildWorkflow } from './watch-build-workflow.ts'

type WatchTarget = {
  path: string
  filenames?: ReadonlySet<string>
  recursive?: boolean
}

const WATCH_TARGETS: WatchTarget[] = [
  { path: 'src', recursive: true },
  { path: '.', filenames: new Set(['chrome-support.json', 'package.json', 'vite.config.ts']) },
  { path: 'extension', filenames: new Set(['base.css']) },
  { path: 'scripts', filenames: new Set(['build-extension.ts']) }
]
const DEBOUNCE_MS = 120

type BuildProcessResult = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

class WatchRegistrationError extends Schema.TaggedErrorClass<WatchRegistrationError>()(
  'WatchRegistrationError',
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {}

class BuildProcessError extends Schema.TaggedErrorClass<BuildProcessError>()(
  'BuildProcessError',
  { cause: Schema.Defect() }
) {}

function closeWatcher(watcher: FSWatcher): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      watcher.close()
    } catch {}
  })
}

const subscribeToChanges = Effect.fn('watchBuild.subscribe')(function*(
  onChange: (reason: string) => void
) {
  yield* Effect.forEach(
    WATCH_TARGETS,
    ({ path, filenames, recursive = false }) => Effect.acquireRelease(
      Effect.try({
        try: () => watch(path, { recursive }, (_event, filename) => {
          const changedPath = filename?.toString()
          if (filenames && (!changedPath || !filenames.has(changedPath))) return
          onChange(changedPath ? `${path}/${changedPath}` : path)
        }),
        catch: (cause) => WatchRegistrationError.make({ path, cause })
      }),
      closeWatcher
    ),
    { discard: true }
  )
})

const awaitProcessShutdown = Effect.callback<void>((resume) => {
  function cleanup(): void {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }

  function shutdown(): void {
    cleanup()
    resume(Effect.void)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return Effect.sync(cleanup)
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function watchBuildMain(): Promise<number> {
  return Effect.runPromise(watchBuildProgram(awaitProcessShutdown))
}

function watchBuildProgram(awaitShutdown: Effect.Effect<void>): Effect.Effect<number> {
  return Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runBuildProcess = Effect.fn('watchBuild.runBuildProcess')(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make('pnpm', ['build'], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: process.env
      })).pipe(
        Effect.mapError((cause) => BuildProcessError.make({ cause }))
      )
      const code = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => BuildProcessError.make({ cause }))
      )
      return { code, signal: null } satisfies BuildProcessResult
    })

    return yield* runWatchBuildWorkflow({
      debounce: Effect.sleep(DEBOUNCE_MS),
      subscribe: subscribeToChanges,
      runBuild: () => Effect.scoped(runBuildProcess()),
      awaitShutdown,
      onReady: () => {
        console.log(`[watch] watching ${WATCH_TARGETS.map(({ path }) => path).join(', ')}`)
      },
      onBuildStart: (reason) => {
        console.log(`\n[watch] build started (${reason})`)
      },
      onBuildSuccess: ({ code, signal }) => {
        if (signal) console.log(`[watch] build stopped by ${signal}`)
        else if (code === 0) console.log('[watch] build completed')
        else console.log(`[watch] build failed with exit code ${code}`)
      },
      onBuildFailure: (error) => {
        console.error(`[watch] build process failed: ${errorMessage(error.cause)}`)
      }
    })
  }).pipe(
    Effect.as(0),
    Effect.catchTag('WatchRegistrationError', (error) => Effect.sync(() => {
      console.error(`[watch] failed to watch ${error.path}: ${errorMessage(error.cause)}`)
      return 1
    })),
    Effect.provide(NodeServices.layer)
  )
}

if (import.meta.main) {
  watchBuildProgram(Effect.never).pipe(
    Effect.tap((exitCode) => Effect.sync(() => {
      process.exitCode = exitCode
    })),
    NodeRuntime.runMain
  )
}
