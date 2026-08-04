import { Effect, Fiber, FiberHandle, Queue, Ref, Result, Scope } from 'effect'

export type WatchBuildWorkflowOptions<BuildResult, BuildFailure, WatchFailure> = {
  readonly debounce: Effect.Effect<void>
  readonly subscribe: (
    onChange: (reason: string) => void
  ) => Effect.Effect<void, WatchFailure, Scope.Scope>
  readonly runBuild: (reason: string) => Effect.Effect<BuildResult, BuildFailure>
  readonly awaitShutdown: Effect.Effect<void>
  readonly onReady?: (() => void) | undefined
  readonly onBuildStart?: ((reason: string) => void) | undefined
  readonly onBuildSuccess?: ((result: BuildResult) => void) | undefined
  readonly onBuildFailure?: ((failure: BuildFailure) => void) | undefined
}

const runWatchBuildWorkflowScoped = Effect.fn('watchBuild.runWorkflow')(function*<
  BuildResult,
  BuildFailure,
  WatchFailure
>(options: WatchBuildWorkflowOptions<BuildResult, BuildFailure, WatchFailure>) {
  const buildRequests = yield* Queue.sliding<string>(1)
  const building = yield* Ref.make(false)
  const runDebounced = yield* FiberHandle.makeRuntime<never, never, void>()

  function scheduleBuild(reason: string): void {
    void runDebounced(Effect.gen(function*() {
      yield* options.debounce
      const isBuilding = yield* Ref.get(building)
      yield* Queue.offer(buildRequests, isBuilding ? 'queued changes' : reason)
    }))
  }

  yield* options.subscribe(scheduleBuild)
  const shutdownFiber = yield* options.awaitShutdown.pipe(
    Effect.forkScoped({ startImmediately: true })
  )

  const runBuild = Effect.fn('watchBuild.runBuild')(function*(reason: string) {
    const build = Effect.gen(function*() {
      yield* Ref.set(building, true)
      yield* Effect.sync(() => options.onBuildStart?.(reason))
      const result = yield* Effect.result(options.runBuild(reason))
      yield* Ref.set(building, false)
      yield* Effect.sync(() => {
        if (Result.isSuccess(result)) options.onBuildSuccess?.(result.success)
        else options.onBuildFailure?.(result.failure)
      })
    })

    return yield* build.pipe(Effect.ensuring(Ref.set(building, false)))
  })

  const runBuildRequests = Effect.fn('watchBuild.runBuildRequests')(function*() {
    while (true) {
      const reason = yield* Queue.take(buildRequests)
      yield* runBuild(reason)
    }
  })

  yield* Effect.sync(() => options.onReady?.())
  yield* Queue.offer(buildRequests, 'initial')
  yield* runBuildRequests().pipe(Effect.forkScoped({ startImmediately: true }))
  return yield* Fiber.join(shutdownFiber)
})

export function runWatchBuildWorkflow<BuildResult, BuildFailure, WatchFailure>(
  options: WatchBuildWorkflowOptions<BuildResult, BuildFailure, WatchFailure>
): Effect.Effect<void, WatchFailure> {
  return Effect.scoped(runWatchBuildWorkflowScoped(options))
}
