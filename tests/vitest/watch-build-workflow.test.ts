import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Queue } from 'effect'

import { runWatchBuildWorkflow } from '../../scripts/watch-build-workflow.js'

type DebounceControl = {
  readonly complete: () => void
  readonly interrupted: () => boolean
}

type BuildControl = {
  readonly complete: () => void
  readonly reason: string
  readonly result: string
}

it.effect('watch workflow debounces changes and coalesces one trailing build', () => Effect.gen(function* () {
  let onChange: ((reason: string) => void) | undefined
  let subscriptionReleased = false
  const buildReasons: string[] = []
  const buildResults: string[] = []
  const debounceStarted = yield* Queue.unbounded<DebounceControl>()
  const buildStarted = yield* Queue.unbounded<BuildControl>()
  const buildSucceeded = yield* Queue.unbounded<string>()
  const shutdown = yield* Deferred.make<void>()

  const debounce = Effect.callback<void>((resume) => {
    let wasInterrupted = false
    Queue.offerUnsafe(debounceStarted, {
      complete: () => resume(Effect.void),
      interrupted: () => wasInterrupted,
    })
    return Effect.sync(() => {
      wasInterrupted = true
    })
  })

  const workflow = runWatchBuildWorkflow({
    debounce,
    subscribe: (listener) => Effect.acquireRelease(
      Effect.sync(() => {
        onChange = listener
      }),
      () => Effect.sync(() => {
        subscriptionReleased = true
      }),
    ),
    runBuild: (reason) => Effect.callback<string>((resume) => {
      buildReasons.push(reason)
      const result = `result ${buildReasons.length}`
      Queue.offerUnsafe(buildStarted, {
        complete: () => resume(Effect.succeed(result)),
        reason,
        result,
      })
      return Effect.void
    }),
    awaitShutdown: Deferred.await(shutdown),
    onBuildSuccess: (result) => {
      buildResults.push(result)
      Queue.offerUnsafe(buildSucceeded, result)
    },
  })
  const workflowFiber = yield* workflow.pipe(Effect.forkChild({ startImmediately: true }))

  const initialBuild = yield* Queue.take(buildStarted)
  assert.equal(initialBuild.reason, 'initial')
  const change = onChange
  assert.ok(change)

  change('src/first.ts')
  const firstDebounce = yield* Queue.take(debounceStarted)
  change('src/latest.ts')
  const latestDebounce = yield* Queue.take(debounceStarted)
  assert.equal(firstDebounce.interrupted(), true)
  latestDebounce.complete()
  yield* Effect.yieldNow
  assert.deepEqual(buildReasons, ['initial'])

  initialBuild.complete()
  assert.equal(yield* Queue.take(buildSucceeded), initialBuild.result)
  const queuedBuild = yield* Queue.take(buildStarted)
  assert.equal(queuedBuild.reason, 'queued changes')
  queuedBuild.complete()
  assert.equal(yield* Queue.take(buildSucceeded), queuedBuild.result)

  change('src/idle.ts')
  const idleDebounce = yield* Queue.take(debounceStarted)
  idleDebounce.complete()
  const idleBuild = yield* Queue.take(buildStarted)
  assert.equal(idleBuild.reason, 'src/idle.ts')
  idleBuild.complete()
  assert.equal(yield* Queue.take(buildSucceeded), idleBuild.result)
  assert.deepEqual(buildResults, ['result 1', 'result 2', 'result 3'])

  yield* Deferred.succeed(shutdown, undefined)
  yield* Fiber.join(workflowFiber)
  assert.equal(subscriptionReleased, true)
}))

it.effect('watch workflow reports a typed build failure and continues watching', () => Effect.gen(function* () {
  let onChange: ((reason: string) => void) | undefined
  const buildReasons: string[] = []
  const failures = yield* Queue.unbounded<string>()
  const successes = yield* Queue.unbounded<string>()
  const shutdown = yield* Deferred.make<void>()

  const workflowFiber = yield* runWatchBuildWorkflow({
    debounce: Effect.void,
    subscribe: (listener) => Effect.acquireRelease(
      Effect.sync(() => {
        onChange = listener
      }),
      () => Effect.void,
    ),
    runBuild: (reason) => {
      buildReasons.push(reason)
      return buildReasons.length === 1 ? Effect.fail('spawn failed') : Effect.succeed(reason)
    },
    awaitShutdown: Deferred.await(shutdown),
    onBuildFailure: (failure) => {
      Queue.offerUnsafe(failures, failure)
    },
    onBuildSuccess: (result) => {
      Queue.offerUnsafe(successes, result)
    },
  }).pipe(Effect.forkChild({ startImmediately: true }))

  assert.equal(yield* Queue.take(failures), 'spawn failed')
  const change = onChange
  assert.ok(change)
  change('src/retry.ts')
  assert.equal(yield* Queue.take(successes), 'src/retry.ts')
  assert.deepEqual(buildReasons, ['initial', 'src/retry.ts'])

  yield* Deferred.succeed(shutdown, undefined)
  yield* Fiber.join(workflowFiber)
}))

it.effect('watch workflow interrupts the active build and releases subscriptions on shutdown', () => Effect.gen(function* () {
  let buildReleased = false
  let subscriptionReleased = false
  const buildAcquired = yield* Queue.unbounded<void>()
  const shutdown = yield* Deferred.make<void>()

  const workflowFiber = yield* runWatchBuildWorkflow({
    debounce: Effect.void,
    subscribe: () => Effect.acquireRelease(
      Effect.void,
      () => Effect.sync(() => {
        subscriptionReleased = true
      }),
    ),
    runBuild: () => Effect.acquireUseRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(buildAcquired, undefined)
      }),
      () => Effect.never,
      () => Effect.sync(() => {
        buildReleased = true
      }),
    ),
    awaitShutdown: Deferred.await(shutdown),
  }).pipe(Effect.forkChild({ startImmediately: true }))

  yield* Queue.take(buildAcquired)
  yield* Deferred.succeed(shutdown, undefined)
  yield* Fiber.join(workflowFiber)

  assert.equal(buildReleased, true)
  assert.equal(subscriptionReleased, true)
}))
