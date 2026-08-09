import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

import { Deferred, Effect } from 'effect'

import { runWatchBuildWorkflow } from '../scripts/watch-build-workflow.js'

type DebounceControl = {
  readonly complete: () => void
  interrupted: boolean
}

type BuildControl = {
  readonly complete: () => void
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message)
    await setImmediate()
  }
}

test('watch workflow debounces changes and coalesces one trailing build', async () => {
  let onChange: ((reason: string) => void) | undefined
  let subscriptionReleased = false
  const debounceControls: DebounceControl[] = []
  const buildControls: BuildControl[] = []
  const buildReasons: string[] = []
  const buildResults: string[] = []
  const shutdown = Deferred.makeUnsafe<void>()

  const debounce = Effect.callback<void>((resume) => {
    const control: DebounceControl = {
      complete: () => resume(Effect.void),
      interrupted: false,
    }
    debounceControls.push(control)
    return Effect.sync(() => {
      control.interrupted = true
    })
  })

  const running = Effect.runPromise(runWatchBuildWorkflow({
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
      const control: BuildControl = {
        complete: () => resume(Effect.succeed(result)),
      }
      buildControls.push(control)
      return Effect.void
    }),
    awaitShutdown: Deferred.await(shutdown),
    onBuildSuccess: (result) => {
      buildResults.push(result)
    },
  }))

  try {
    await waitFor(() => onChange !== undefined && buildControls.length === 1, 'initial build did not start')
    if (!onChange) throw new Error('change subscription was not installed')

    onChange('src/first.ts')
    await waitFor(() => debounceControls.length === 1, 'first debounce did not start')
    onChange('src/latest.ts')
    await waitFor(
      () => debounceControls.length === 2 && debounceControls[0]?.interrupted === true,
      'latest change did not replace the first debounce',
    )
    debounceControls[1]?.complete()
    await setImmediate()
    assert.deepEqual(buildReasons, ['initial'])

    buildControls[0]?.complete()
    await waitFor(() => buildControls.length === 2, 'queued build did not start')
    assert.deepEqual(buildReasons, ['initial', 'queued changes'])
    buildControls[1]?.complete()
    await waitFor(() => buildResults.length === 2, 'queued build did not settle')

    onChange('src/idle.ts')
    await waitFor(() => debounceControls.length === 3, 'idle debounce did not start')
    debounceControls[2]?.complete()
    await waitFor(() => buildControls.length === 3, 'idle build did not start')
    assert.deepEqual(buildReasons, ['initial', 'queued changes', 'src/idle.ts'])
    buildControls[2]?.complete()
    await waitFor(() => buildResults.length === 3, 'idle build did not settle')
    assert.deepEqual(buildResults, ['result 1', 'result 2', 'result 3'])
  } finally {
    Effect.runSync(Deferred.succeed(shutdown, undefined))
    await running
  }

  assert.equal(subscriptionReleased, true)
})

test('watch workflow reports a typed build failure and continues watching', async () => {
  let onChange: ((reason: string) => void) | undefined
  const buildReasons: string[] = []
  const failures: string[] = []
  const successes: string[] = []
  const shutdown = Deferred.makeUnsafe<void>()

  const running = Effect.runPromise(runWatchBuildWorkflow({
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
      failures.push(failure)
    },
    onBuildSuccess: (result) => {
      successes.push(result)
    },
  }))

  try {
    await waitFor(() => failures.length === 1 && onChange !== undefined, 'build failure was not reported')
    if (!onChange) throw new Error('change subscription was not installed')
    onChange('src/retry.ts')
    await waitFor(() => successes.length === 1, 'watcher did not recover after the build failure')
    assert.deepEqual(buildReasons, ['initial', 'src/retry.ts'])
    assert.deepEqual(failures, ['spawn failed'])
    assert.deepEqual(successes, ['src/retry.ts'])
  } finally {
    Effect.runSync(Deferred.succeed(shutdown, undefined))
    await running
  }
})

test('watch workflow interrupts the active build and releases subscriptions on shutdown', async () => {
  let buildAcquired = false
  let buildReleased = false
  let subscriptionReleased = false
  const shutdown = Deferred.makeUnsafe<void>()

  const running = Effect.runPromise(runWatchBuildWorkflow({
    debounce: Effect.void,
    subscribe: () => Effect.acquireRelease(
      Effect.void,
      () => Effect.sync(() => {
        subscriptionReleased = true
      }),
    ),
    runBuild: () => Effect.acquireUseRelease(
      Effect.sync(() => {
        buildAcquired = true
      }),
      () => Effect.never,
      () => Effect.sync(() => {
        buildReleased = true
      }),
    ),
    awaitShutdown: Deferred.await(shutdown),
  }))

  await waitFor(() => buildAcquired, 'initial build did not acquire its resource')
  Effect.runSync(Deferred.succeed(shutdown, undefined))
  await running

  assert.equal(buildReleased, true)
  assert.equal(subscriptionReleased, true)
})
