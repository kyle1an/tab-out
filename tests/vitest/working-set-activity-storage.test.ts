import { assert, it, vi } from '@effect/vitest'
import { Effect, Result } from 'effect'

import {
  WorkingSetActivityAuthorityError,
} from '../../src/extension/background/working-set-activity-authority.js'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityWrite,
} from '../../src/extension/background/working-set-activity-storage.js'
import { makeWorkingSetActivityStorageLayer } from '../../src/extension/background/working-set-activity-storage-layer.js'
import {
  emptyWorkingSetActivity,
  recordWorkingSetActivityMutation,
} from '../../src/extension/working-set.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'

it.effect('Working Set storage reports malformed and unsupported outer schemas as typed read failures', () =>
  Effect.gen(function* () {
    const malformedResult = yield* Effect.gen(function* () {
      const storage = yield* WorkingSetActivityStorage
      return yield* Effect.result(storage.read())
    }).pipe(Effect.provide(WorkingSetActivityStorage.layer({
      read: () => Promise.resolve({ version: 1, records: [] }),
      write: () => Promise.resolve(),
      replace: () => Promise.resolve(),
    })))
    assert.isTrue(Result.isFailure(malformedResult))
    if (Result.isFailure(malformedResult)) {
      assert.strictEqual(malformedResult.failure.operation, 'read')
      assert.strictEqual(malformedResult.failure.reason, 'malformed')
    }

    const unsupportedResult = yield* Effect.gen(function* () {
      const storage = yield* WorkingSetActivityStorage
      return yield* Effect.result(storage.read())
    }).pipe(Effect.provide(WorkingSetActivityStorage.layer({
      read: () => Promise.resolve({ version: 2, records: {} }),
      write: () => Promise.resolve(),
      replace: () => Promise.resolve(),
    })))
    assert.isTrue(Result.isFailure(unsupportedResult))
    if (Result.isFailure(unsupportedResult)) {
      assert.strictEqual(unsupportedResult.failure.operation, 'read')
      assert.strictEqual(unsupportedResult.failure.reason, 'unsupported-version')
    }
  }))

it.effect('Working Set storage repairs row and event damage after accepting the outer schema', () => {
  const now = Date.now()
  const key = 'https://example.test/docs'

  return Effect.gen(function* () {
    const storage = yield* WorkingSetActivityStorage
    const activity = yield* storage.read()

    assert.deepStrictEqual(Object.keys(activity.records), [key])
    assert.deepStrictEqual(activity.records[key]?.events, [
      { kind: 'activation', at: now - 1_000 },
    ])
  }).pipe(Effect.provide(WorkingSetActivityStorage.layer({
    read: () => Promise.resolve({
      version: 1,
      records: {
        [key]: {
          url: key,
          title: 'Docs',
          events: [
            { kind: 'activation', at: now - 1_000 },
            { kind: 'navigation', at: 'invalid' },
          ],
        },
        malformed: null,
      },
    }),
    write: () => Promise.resolve(),
    replace: () => Promise.resolve(),
  })))
})

it.effect('Working Set storage forwards record deltas and full replacements to its backend', () => {
  let written: WorkingSetActivityWrite | undefined
  let replaced: WorkingSetActivityStore | undefined

  return Effect.gen(function* () {
    const storage = yield* WorkingSetActivityStorage
    const change = recordWorkingSetActivityMutation(emptyWorkingSetActivity(), {
      kind: 'activation',
      at: Date.now(),
      tab: {
        url: 'https://example.test/docs',
        rawUrl: 'https://example.test/docs',
        title: 'Docs',
      },
    })

    yield* storage.write(change)
    yield* storage.replace(change.activity)

    assert.strictEqual(written, change)
    assert.strictEqual(replaced, change.activity)
  }).pipe(Effect.provide(WorkingSetActivityStorage.layer({
    read: () => Promise.resolve(undefined),
    write: (change) => {
      written = change
      return Promise.resolve()
    },
    replace: (activity) => {
      replaced = activity
      return Promise.resolve()
    },
  })))
})

it.effect('Working Set storage treats an unavailable Chrome backend as unknown, not known empty', () => {
  vi.stubGlobal('chrome', {})

  return Effect.gen(function* () {
    const storage = yield* WorkingSetActivityStorage
    const result = yield* Effect.result(storage.read())

    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure.operation, 'read')
      assert.strictEqual(result.failure.reason, 'backend')
      assert.instanceOf(result.failure.cause, WorkingSetActivityAuthorityError)
      if (result.failure.cause instanceof WorkingSetActivityAuthorityError) {
        assert.strictEqual(result.failure.cause.phase, 'marker-read')
        assert.match(
          String(result.failure.cause.cause),
          /local storage is unavailable/,
        )
      }
    }
  }).pipe(Effect.provide(makeWorkingSetActivityStorageLayer(chrome)))
})

it.effect('Working Set storage keeps Layer construction synchronous and closes its backend with the scope', () => {
  let closeCount = 0
  const storageLayer = WorkingSetActivityStorage.layer({
    read: () => Promise.resolve(undefined),
    write: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    close: () => {
      closeCount += 1
      return Promise.resolve()
    },
  })

  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* WorkingSetActivityStorage
        assert.strictEqual(closeCount, 0)
      }).pipe(Effect.provide(storageLayer)),
    )

    assert.strictEqual(closeCount, 1)
  })
})
