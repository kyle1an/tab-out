import { spawn, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'

import { Data, Effect } from 'effect'

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

class WatchRegistrationError extends Data.TaggedError('WatchRegistrationError')<{
  readonly path: string
  readonly cause: unknown
}> {}

class BuildProcessError extends Data.TaggedError('BuildProcessError')<{
  readonly cause: unknown
}> {}

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
        catch: (cause) => new WatchRegistrationError({ path, cause })
      }),
      closeWatcher
    ),
    { discard: true }
  )
})

function waitForBuildProcess(
  buildProcess: ChildProcess
): Effect.Effect<BuildProcessResult, BuildProcessError> {
  return Effect.callback((resume) => {
    function cleanup(): void {
      buildProcess.removeListener('exit', onExit)
      buildProcess.removeListener('error', onError)
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup()
      resume(Effect.succeed({ code, signal }))
    }

    function onError(cause: Error): void {
      cleanup()
      resume(Effect.fail(new BuildProcessError({ cause })))
    }

    buildProcess.once('exit', onExit)
    buildProcess.once('error', onError)
    return Effect.sync(cleanup)
  })
}

function stopBuildProcess(buildProcess: ChildProcess): Effect.Effect<void> {
  return Effect.sync(() => {
    if (
      buildProcess.pid === undefined ||
      buildProcess.exitCode !== null ||
      buildProcess.signalCode !== null
    ) return
    try {
      buildProcess.kill('SIGTERM')
    } catch {}
  })
}

const runBuildProcess = Effect.fn('watchBuild.runBuildProcess')(function*() {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => spawn('pnpm', ['build'], {
        stdio: 'inherit',
        env: process.env
      }),
      catch: (cause) => new BuildProcessError({ cause })
    }),
    waitForBuildProcess,
    stopBuildProcess
  )
})

const awaitShutdown = Effect.callback<void>((resume) => {
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
  return Effect.runPromise(runWatchBuildWorkflow({
    debounce: Effect.sleep(DEBOUNCE_MS),
    subscribe: subscribeToChanges,
    runBuild: runBuildProcess,
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
  }).pipe(
    Effect.as(0),
    Effect.catchTag('WatchRegistrationError', (error) => Effect.sync(() => {
      console.error(`[watch] failed to watch ${error.path}: ${errorMessage(error.cause)}`)
      return 1
    }))
  ))
}

if (import.meta.main) {
  watchBuildMain().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (cause: unknown) => {
      console.error(`[watch] unexpected failure: ${errorMessage(cause)}`)
      process.exitCode = 1
    }
  )
}
