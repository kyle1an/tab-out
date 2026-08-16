import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
  RetentionHealth,
  parseRetentionHealthEpisodeValue,
} from '../../src/extension/retention-health.js'

it.effect('retention health keeps one metadata-free failure episode', () => {
  let stored: unknown
  let timestamp = 100

  return Effect.gen(function* () {
    const health = yield* RetentionHealth
    yield* health.recordFailure({
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry',
    })
    timestamp = 150
    yield* health.recordFailure({
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry',
    })

    assert.deepStrictEqual(stored, {
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry',
      startedAt: 100,
      lastFailedAt: 150,
    })
    const episode = parseRetentionHealthEpisodeValue(stored)
    assert.isNotNull(episode)
    if (episode !== null) {
      assert.deepStrictEqual(Object.keys(episode).sort(), [
        'failureKind',
        'lastFailedAt',
        'operationKind',
        'retryState',
        'startedAt',
      ])
    }
  }).pipe(Effect.provide(RetentionHealth.layer({
    read: async () => stored,
    write: async (episode) => {
      stored = episode
    },
    clear: async () => {
      stored = undefined
    },
  }, () => timestamp)))
})

it.effect('retention health clears silently only after the matching operation recovers', () => {
  let stored: unknown
  let clearCount = 0

  return Effect.gen(function* () {
    const health = yield* RetentionHealth
    yield* health.recordFailure({
      failureKind: 'restore',
      operationKind: 'durable-inventory-reset',
      retryState: 'not-applicable',
    })
    yield* health.recordRecovery('automatic-capture')
    assert.strictEqual(clearCount, 0)
    assert.isNotNull(yield* health.getEpisode())

    yield* health.recordRecovery('durable-inventory-reset')
    assert.strictEqual(clearCount, 1)
    assert.isNull(yield* health.getEpisode())
  }).pipe(Effect.provide(RetentionHealth.layer({
    read: async () => stored,
    write: async (episode) => {
      stored = episode
    },
    clear: async () => {
      clearCount += 1
      stored = undefined
    },
  }, () => 100)))
})

it.effect('retention health storage unavailability never fails its callers', () =>
  Effect.gen(function* () {
    const health = yield* RetentionHealth

    assert.isNull(yield* health.getEpisode())
    yield* health.recordFailure({
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry',
    })
    yield* health.recordRecovery('automatic-capture')
  }).pipe(Effect.provide(RetentionHealth.layer({
    read: async () => {
      throw new Error('session storage unavailable')
    },
    write: async () => {
      throw new Error('session storage unavailable')
    },
    clear: async () => {
      throw new Error('session storage unavailable')
    },
  }, () => 100))))

it('retention health rejects malformed or metadata-bearing session values', () => {
  assert.isNull(parseRetentionHealthEpisodeValue({
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry',
    startedAt: 100,
    lastFailedAt: 100,
    url: 'https://example.test/private',
  }))
  assert.isNull(parseRetentionHealthEpisodeValue(undefined))
})
