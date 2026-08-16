import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { ClosedTabRestoreWatchdogs } from '../../src/extension/closed-tab-restore-watchdogs.js'

it.effect('closed-tab restore watchdogs replace by id and stop with their scope', () =>
  Effect.gen(function* () {
    const calls: string[] = []

    yield* Effect.scoped(
      Effect.gen(function* () {
        const watchdogs = yield* ClosedTabRestoreWatchdogs
        yield* watchdogs.schedule('restore-alpha', 100, () => calls.push('overtaken'))
        yield* watchdogs.schedule('restore-alpha', 100, () => calls.push('latest'))

        yield* TestClock.adjust(100)
        assert.deepStrictEqual(calls, ['latest'])

        yield* watchdogs.schedule('restore-beta', 100, () => calls.push('disposed'))
      }).pipe(Effect.provide(ClosedTabRestoreWatchdogs.layer)),
    )

    yield* TestClock.adjust(100)
    assert.deepStrictEqual(calls, ['latest'])
  }))
