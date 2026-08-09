import assert from 'node:assert/strict'
import test from 'node:test'

import { Effect, ManagedRuntime, Result } from 'effect'

import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import {
  WORKING_SET_ACTIVITY_KEY,
  WorkingSetActivityStorage,
} from '../src/extension/background/working-set-activity-storage.js'
import {
  emptyWorkingSetActivity,
  recordWorkingSetActivityMutation,
} from '../src/extension/working-set.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'
import {
  benchmarkBackend,
  makeWorkingSetActivityStorageLayer,
} from './extension/working-set-backends/current-envelope-layer.js'
import { jsonUtf8ByteLength } from './extension/working-set-backends/benchmark-backend.js'

test('current benchmark adapter preserves whole-envelope writes and reports diagnostics', async (t) => {
  const fakeChromeApi = createFakeChromeApi()
  const chromeApi = fakeChromeApi as unknown as ChromeApi
  assert.equal(benchmarkBackend.variant, 'current')
  await benchmarkBackend.reset(chromeApi)
  const runtime = ManagedRuntime.make(
    makeWorkingSetActivityStorageLayer(chromeApi),
  )
  runtime.runSync(Effect.void)
  t.after(async () => {
    await runtime.dispose()
    await benchmarkBackend.close()
  })
  const storage = runtime.runSync(WorkingSetActivityStorage)
  const change = recordWorkingSetActivityMutation(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: 123_456,
    tab: {
      url: 'https://example.test/docs',
      rawUrl: 'https://example.test/docs',
      title: 'Example Docs',
    },
  })

  await runtime.runPromise(storage.write(change))

  assert.deepEqual(
    await fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY),
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

  await runtime.runPromise(storage.replace(emptyWorkingSetActivity()))
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
  await runtime.runPromise(storage.replace(change.activity))
  benchmarkBackend.failNextMutation()
  await runtime.runPromise(storage.replace(change.activity))
  const syntheticFailure = await runtime.runPromise(Effect.result(
    storage.write(retryChange),
  ))
  assert.ok(Result.isFailure(syntheticFailure))
  assert.equal(syntheticFailure.failure.reason, 'backend')
  assert.deepEqual(
    await fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY),
    { [WORKING_SET_ACTIVITY_KEY]: change.activity },
    'synthetic failure must happen before persistence',
  )
  await runtime.runPromise(storage.write(retryChange))
  assert.deepEqual(
    await fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY),
    { [WORKING_SET_ACTIVITY_KEY]: retryChange.activity },
    'the one-shot failure must not affect the following write',
  )

  await benchmarkBackend.corrupt('row', chromeApi)
  const repaired = await runtime.runPromise(storage.read())
  assert.deepEqual(
    Object.keys(repaired.records),
    ['https://example.test/benchmark-valid'],
    'invalid rows are isolated while a valid row survives',
  )
  await benchmarkBackend.corrupt('missing-required-store', chromeApi)
  assert.deepEqual(
    await runtime.runPromise(storage.read()),
    emptyWorkingSetActivity(),
    'removing the envelope is the known-empty equivalent for key storage',
  )
  await benchmarkBackend.corrupt('outer-version', chromeApi)
  const unsupported = await runtime.runPromise(Effect.result(storage.read()))
  assert.ok(Result.isFailure(unsupported))
  assert.equal(unsupported.failure.reason, 'unsupported-version')

  await benchmarkBackend.reset(chromeApi)
  assert.deepEqual(
    await fakeChromeApi.storage.local.get(WORKING_SET_ACTIVITY_KEY),
    {},
  )
  assert.equal(benchmarkBackend.writeInvocationCount(), 0)
  assert.equal(benchmarkBackend.lastMutationLogicalBytes(), 0)
  assert.deepEqual(benchmarkBackend.lastMutationPhysicalWrites(), [])
})
