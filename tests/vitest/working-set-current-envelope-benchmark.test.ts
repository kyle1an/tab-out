import assert from 'node:assert/strict'
import { it } from '@effect/vitest'

import { Effect, Result } from 'effect'

import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import { WorkingSetActivityStorage } from '../../src/extension/background/working-set-activity-storage.js'
import {
  emptyWorkingSetActivity,
  recordWorkingSetActivityMutation,
} from '../../src/extension/working-set.js'
import { createFakeChromeApi } from '../helpers/fake-chrome.mjs'
import {
  benchmarkBackend,
  FROZEN_WORKING_SET_ACTIVITY_KEY as WORKING_SET_ACTIVITY_KEY,
  makeWorkingSetActivityStorageLayer,
} from '../extension/working-set-backends/current-envelope-layer.js'
import { jsonUtf8ByteLength } from '../extension/working-set-backends/benchmark-backend.js'

it.effect('current benchmark adapter preserves whole-envelope writes and reports diagnostics', () => Effect.gen(function* () {
  const fakeChromeApi = createFakeChromeApi()
  const chromeApi = fakeChromeApi as unknown as ChromeApi
  assert.equal(benchmarkBackend.variant, 'current')
  yield* Effect.promise(() => benchmarkBackend.reset(chromeApi))
  yield* Effect.addFinalizer(() => Effect.sync(() => benchmarkBackend.close()))

  yield* Effect.gen(function* () {
    const storage = yield* WorkingSetActivityStorage
    const change = recordWorkingSetActivityMutation(emptyWorkingSetActivity(), {
      kind: 'activation',
      at: 123_456,
      tab: {
        url: 'https://example.test/docs',
        rawUrl: 'https://example.test/docs',
        title: 'Example Docs',
      },
    })

    yield* storage.write(change)

    assert.deepEqual(
      yield* Effect.promise(() => fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY)),
      { [WORKING_SET_ACTIVITY_KEY]: change.activity },
    )
    assert.equal(benchmarkBackend.writeInvocationCount(), 1)
    assert.equal(
      benchmarkBackend.lastMutationLogicalBytes(),
      jsonUtf8ByteLength(change.activity),
    )
    assert.deepEqual(
      benchmarkBackend.lastMutationPhysicalWrites(),
      [WORKING_SET_ACTIVITY_KEY],
    )

    yield* storage.replace(emptyWorkingSetActivity())
    assert.equal(
      benchmarkBackend.writeInvocationCount(),
      1,
      'benchmark seeding must not count as a domain mutation',
    )

    const retryChange = recordWorkingSetActivityMutation(change.activity, {
      kind: 'navigation',
      at: 123_457,
      tab: {
        url: 'https://example.test/docs',
        rawUrl: 'https://example.test/docs',
        title: 'Example Docs',
      },
    })
    yield* storage.replace(change.activity)
    benchmarkBackend.failNextMutation()
    yield* storage.replace(change.activity)
    const syntheticFailure = yield* Effect.result(storage.write(retryChange))
    assert.ok(Result.isFailure(syntheticFailure))
    assert.equal(syntheticFailure.failure.reason, 'backend')
    assert.deepEqual(
      yield* Effect.promise(() => fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY)),
      { [WORKING_SET_ACTIVITY_KEY]: change.activity },
      'synthetic failure must happen before persistence',
    )
    yield* storage.write(retryChange)
    assert.deepEqual(
      yield* Effect.promise(() => fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY)),
      { [WORKING_SET_ACTIVITY_KEY]: retryChange.activity },
      'the one-shot failure must not affect the following write',
    )

    yield* Effect.promise(() => benchmarkBackend.corrupt('row', chromeApi))
    const repaired = yield* storage.read()
    assert.deepEqual(
      Object.keys(repaired.records),
      ['https://example.test/benchmark-valid'],
      'invalid rows are isolated while a valid row survives',
    )
    yield* Effect.promise(() => benchmarkBackend.corrupt('missing-required-store', chromeApi))
    assert.deepEqual(
      yield* storage.read(),
      emptyWorkingSetActivity(),
      'removing the envelope is the known-empty equivalent for key storage',
    )
    yield* Effect.promise(() => benchmarkBackend.corrupt('outer-version', chromeApi))
    const unsupported = yield* Effect.result(storage.read())
    assert.ok(Result.isFailure(unsupported))
    assert.equal(unsupported.failure.reason, 'unsupported-version')

    yield* Effect.promise(() => benchmarkBackend.reset(chromeApi))
    assert.deepEqual(
      yield* Effect.promise(() => fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY)),
      {},
    )
    assert.equal(benchmarkBackend.writeInvocationCount(), 0)
    assert.equal(benchmarkBackend.lastMutationLogicalBytes(), 0)
    assert.deepEqual(benchmarkBackend.lastMutationPhysicalWrites(), [])
  }).pipe(Effect.provide(makeWorkingSetActivityStorageLayer(chromeApi)))
}))
