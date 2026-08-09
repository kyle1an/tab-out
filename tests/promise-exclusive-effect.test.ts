import assert from 'node:assert/strict'
import test from 'node:test'

import { Deferred, Effect, Fiber, Result } from 'effect'

import { runPromiseExclusiveEffect } from '../src/extension/promise-exclusive-effect.js'

test('exclusive Effect bridge holds the callback lock until the workflow exits', async () => {
  const events: string[] = []
  const runExclusive = async <Value>(task: () => Promise<Value>): Promise<Value> => {
    events.push('acquired')
    try {
      return await task()
    } finally {
      events.push('released')
    }
  }

  const value = await Effect.runPromise(runPromiseExclusiveEffect(
    runExclusive,
    Effect.sync(() => {
      events.push('effect')
      return 42
    }),
    (cause) => cause,
  ))

  assert.equal(value, 42)
  assert.deepEqual(events, ['acquired', 'effect', 'released'])
})

test('exclusive Effect bridge maps acquisition rejection without running the workflow', async () => {
  let ran = false
  const failure = new Error('lock unavailable')
  const result = await Effect.runPromise(Effect.result(runPromiseExclusiveEffect(
    async () => {
      throw failure
    },
    Effect.sync(() => {
      ran = true
    }),
    (cause) => ({ cause }),
  )))

  assert.equal(ran, false)
  assert.ok(Result.isFailure(result))
  if (Result.isFailure(result)) assert.equal(result.failure.cause, failure)
})

test('interrupting an acquired exclusive Effect releases the callback lock', async () => {
  const acquired = Deferred.makeUnsafe<void>()
  const neverFinishes = Deferred.makeUnsafe<void>()
  let released = false
  const runExclusive = async <Value>(task: () => Promise<Value>): Promise<Value> => {
    try {
      Effect.runSync(Deferred.succeed(acquired, undefined))
      return await task()
    } finally {
      released = true
    }
  }
  const fiber = Effect.runFork(runPromiseExclusiveEffect(
    runExclusive,
    Deferred.await(neverFinishes),
    (cause) => cause,
  ))

  await Effect.runPromise(Deferred.await(acquired))
  await Effect.runPromise(Fiber.interrupt(fiber))
  await Promise.resolve()

  assert.equal(released, true)
})
