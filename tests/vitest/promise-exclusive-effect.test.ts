import { assert, it } from '@effect/vitest'

import { Deferred, Effect, Fiber, Result } from 'effect'

import { runPromiseExclusiveEffect } from '../../src/extension/promise-exclusive-effect.js'

it.effect('exclusive Effect bridge holds the callback lock until the workflow exits', () =>
  Effect.gen(function* () {
    const events: string[] = []
    const runExclusive = async <Value>(task: () => Promise<Value>): Promise<Value> => {
      events.push('acquired')
      try {
        return await task()
      } finally {
        events.push('released')
      }
    }

    const value = yield* runPromiseExclusiveEffect(
      runExclusive,
      Effect.sync(() => {
        events.push('effect')
        return 42
      }),
      (cause) => cause,
    )
    yield* Effect.promise(() => Promise.resolve())

    assert.strictEqual(value, 42)
    assert.deepStrictEqual(events, ['acquired', 'effect', 'released'])
  }))

it.effect('exclusive Effect bridge maps acquisition rejection without running the workflow', () =>
  Effect.gen(function* () {
    let ran = false
    const failure = new Error('lock unavailable')
    const result = yield* Effect.result(runPromiseExclusiveEffect(
      async () => {
        throw failure
      },
      Effect.sync(() => {
        ran = true
      }),
      (cause) => ({ cause }),
    ))

    assert.isFalse(ran)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure.cause, failure)
  }))

it.effect('interrupting an acquired exclusive Effect releases the callback lock', () =>
  Effect.gen(function* () {
    const acquired = Deferred.makeUnsafe<void>()
    const neverFinishes = Deferred.makeUnsafe<void>()
    let released = false
    const signalAcquired = () => {
      Deferred.doneUnsafe(acquired, Effect.void)
    }
    const runExclusive = async <Value>(task: () => Promise<Value>): Promise<Value> => {
      try {
        const result = task()
        queueMicrotask(signalAcquired)
        return await result
      } finally {
        released = true
      }
    }
    const fiber = yield* Effect.forkChild(runPromiseExclusiveEffect(
      runExclusive,
      Deferred.await(neverFinishes),
      (cause) => cause,
    ))

    yield* Deferred.await(acquired)
    yield* Fiber.interrupt(fiber)
    yield* Effect.callback<void>((resume) => {
      queueMicrotask(() => resume(Effect.void))
    })

    assert.isTrue(released)
  }))
