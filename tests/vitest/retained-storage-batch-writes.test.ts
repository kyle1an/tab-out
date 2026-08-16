import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Effect } from 'effect'

import { measureRetainedStorageBatchWrites } from '../helpers/retained-storage-profile.js'

it.effect('a deterministic 500-close batch uses one ledger write and bounded two-phase inventory writes', () =>
  Effect.gen(function* () {
    const measurements = yield* measureRetainedStorageBatchWrites()

    assert.equal(measurements.closeEvents, 500)
    assert.deepEqual(measurements.outcomes, { inserted: 500 })
    assert.equal(measurements.resultingPages, 500)
    assert.equal(measurements.resultingSessionSurfaces, 0)
    assert.equal(measurements.resultingDurableSurfaces, 0)
    assert.ok(measurements.ledgerWrites <= 3)
    assert.equal(measurements.ledgerWrites, 1)
    assert.equal(measurements.sessionWrites, 2)
    assert.equal(measurements.durableWrites, 2)
    assert.equal(measurements.totalWrites, 5)
  }))
