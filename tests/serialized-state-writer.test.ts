import assert from 'node:assert/strict'
import test from 'node:test'

import { createSerializedStateWriter } from '../src/extension/serialized-state-writer.js'
import type { StorageListMutationAttempt } from '../src/extension/storage-list-mutations.js'

test('operation writer returns the authoritative persisted value', async () => {
  const writer = createSerializedStateWriter<string>([], async (operation) => ({
    ok: true,
    previousValue: [],
    value: ['remote', operation]
  }))

  assert.deepEqual(await writer.write('local'), {
    ok: true,
    isLatest: true,
    value: ['remote', 'local']
  })
})

test('a superseded mutation failure does not ask the caller to roll back newer intent', async () => {
  const firstResult = Promise.withResolvers<StorageListMutationAttempt>()
  let calls = 0
  const writer = createSerializedStateWriter<string>([], async () => {
    calls += 1
    if (calls === 1) return firstResult.promise
    return { ok: true, previousValue: [], value: ['one', 'two'] }
  })

  const first = writer.write('one')
  const second = writer.write('two')
  firstResult.resolve({ ok: false, currentValue: [], error: new Error('first write failed') })

  const firstFailure = await first
  assert.equal(firstFailure.ok, false)
  assert.equal(firstFailure.isLatest, false)
  assert.deepEqual(await second, { ok: true, isLatest: true, value: ['one', 'two'] })
})

test('the latest write failure rolls back to the value read inside the transaction', async () => {
  const writer = createSerializedStateWriter<string>(['cached'], async () => ({
    ok: false,
    currentValue: ['remote'],
    error: new Error('latest write failed')
  }))

  const failed = await writer.write('next')

  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.isLatest, true)
  assert.deepEqual(failed.rollbackValue, ['remote'])
  assert.match(String(failed.error), /latest write failed/)
})

test('a read failure preserves the reconciled cache as the rollback value', async () => {
  const writer = createSerializedStateWriter<string>(['cached'], async () => ({
    ok: false,
    currentValue: null,
    error: new Error('read failed')
  }))
  writer.replacePersisted(['live'])

  const failed = await writer.write('next')
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.deepEqual(failed.rollbackValue, ['live'])
})

test('a newer storage event wins over a different in-flight write result', async () => {
  const pendingResult = Promise.withResolvers<StorageListMutationAttempt>()
  const writer = createSerializedStateWriter<string>([], async () => pendingResult.promise)

  const write = writer.write('local')
  writer.replacePersisted(['external'])
  pendingResult.resolve({ ok: true, previousValue: [], value: ['local'] })

  assert.deepEqual(await write, {
    ok: true,
    isLatest: true,
    value: ['external']
  })
})

test('a matching storage event acknowledges its in-flight write result', async () => {
  const pendingResult = Promise.withResolvers<StorageListMutationAttempt>()
  const writer = createSerializedStateWriter<string>([], async () => pendingResult.promise)

  const write = writer.write('local')
  writer.replacePersisted(['local'])
  pendingResult.resolve({ ok: true, previousValue: [], value: ['local'] })

  assert.deepEqual(await write, {
    ok: true,
    isLatest: true,
    value: ['local']
  })
})

test('a newer storage event remains the rollback baseline for an in-flight failure', async () => {
  const pendingResult = Promise.withResolvers<StorageListMutationAttempt>()
  const writer = createSerializedStateWriter<string>(['cached'], async () => pendingResult.promise)

  const write = writer.write('local')
  writer.replacePersisted(['external'])
  pendingResult.resolve({ ok: false, currentValue: ['stale-read'], error: new Error('write failed') })

  const failed = await write
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.isLatest, true)
  assert.deepEqual(failed.rollbackValue, ['external'])
})
