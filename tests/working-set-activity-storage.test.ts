import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Effect, ManagedRuntime, Result } from 'effect'

import {
  WorkingSetActivityStorage,
  type WorkingSetActivityWrite
} from '../src/extension/background/working-set-activity-storage.js'
import { makeWorkingSetActivityStorageLayer } from '../src/extension/background/working-set-activity-storage-layer.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import {
  emptyWorkingSetActivity,
  recordWorkingSetActivityMutation
} from '../src/extension/working-set.js'
import type { WorkingSetActivityStore } from '../src/extension/types'

function makeStorage(
  t: TestContext,
  options: {
    readonly read: () => PromiseLike<unknown>
    readonly write?: (change: WorkingSetActivityWrite) => PromiseLike<void>
    readonly replace?: (activity: WorkingSetActivityStore) => PromiseLike<void>
  }
) {
  const runtime = ManagedRuntime.make(WorkingSetActivityStorage.layer({
    read: options.read,
    write: options.write ?? (() => Promise.resolve()),
    replace: options.replace ?? (() => Promise.resolve())
  }))
  runtime.runSync(Effect.void)
  t.after(() => runtime.dispose())
  return {
    runtime,
    storage: runtime.runSync(WorkingSetActivityStorage)
  }
}

test('Working Set storage reports malformed and unsupported outer schemas as typed read failures', async (t) => {
  const malformed = makeStorage(t, {
    read: () => Promise.resolve({ version: 1, records: [] })
  })
  const malformedResult = await malformed.runtime.runPromise(
    Effect.result(malformed.storage.read())
  )
  assert.ok(Result.isFailure(malformedResult))
  assert.equal(malformedResult.failure.operation, 'read')
  assert.equal(malformedResult.failure.reason, 'malformed')

  const unsupported = makeStorage(t, {
    read: () => Promise.resolve({ version: 2, records: {} })
  })
  const unsupportedResult = await unsupported.runtime.runPromise(
    Effect.result(unsupported.storage.read())
  )
  assert.ok(Result.isFailure(unsupportedResult))
  assert.equal(unsupportedResult.failure.operation, 'read')
  assert.equal(unsupportedResult.failure.reason, 'unsupported-version')
})

test('Working Set storage repairs row and event damage after accepting the outer schema', async (t) => {
  const now = Date.now()
  const key = 'https://example.test/docs'
  const { runtime, storage } = makeStorage(t, {
    read: () => Promise.resolve({
      version: 1,
      records: {
        [key]: {
          url: key,
          title: 'Docs',
          events: [
            { kind: 'activation', at: now - 1_000 },
            { kind: 'navigation', at: 'invalid' }
          ]
        },
        malformed: null
      }
    })
  })

  const activity = await runtime.runPromise(storage.read())

  assert.deepEqual(Object.keys(activity.records), [key])
  assert.deepEqual(activity.records[key]?.events, [
    { kind: 'activation', at: now - 1_000 }
  ])
})

test('Working Set storage forwards record deltas and full replacements to its backend', async (t) => {
  let written: WorkingSetActivityWrite | undefined
  let replaced: WorkingSetActivityStore | undefined
  const { runtime, storage } = makeStorage(t, {
    read: () => Promise.resolve(undefined),
    write: (change) => {
      written = change
      return Promise.resolve()
    },
    replace: (activity) => {
      replaced = activity
      return Promise.resolve()
    }
  })
  const change = recordWorkingSetActivityMutation(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: Date.now(),
    tab: {
      url: 'https://example.test/docs',
      rawUrl: 'https://example.test/docs',
      title: 'Docs'
    }
  })

  await runtime.runPromise(storage.write(change))
  await runtime.runPromise(storage.replace(change.activity))

  assert.strictEqual(written, change)
  assert.strictEqual(replaced, change.activity)
})

test('Working Set storage treats an unavailable Chrome backend as unknown, not known empty', async (t) => {
  const runtime = ManagedRuntime.make(
    makeWorkingSetActivityStorageLayer({} as ChromeApi)
  )
  runtime.runSync(Effect.void)
  t.after(() => runtime.dispose())
  const storage = runtime.runSync(WorkingSetActivityStorage)

  const result = await runtime.runPromise(Effect.result(storage.read()))

  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.operation, 'read')
  assert.equal(result.failure.reason, 'backend')
  assert.match(String(result.failure.cause), /local storage is unavailable/)
})
