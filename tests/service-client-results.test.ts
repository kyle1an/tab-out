import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchTabHistorySnapshotResult } from '../src/extension/tab-history.js'

test('history client distinguishes unavailable service state from a valid empty snapshot', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        throw new Error('Service worker unavailable')
      }
    }
  } as unknown as typeof globalThis.chrome

  const failedHistory = await fetchTabHistorySnapshotResult()
  assert.equal(failedHistory.ok, false)

  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true, snapshot: { entries: [], maxSize: 48 } })
    }
  } as unknown as typeof globalThis.chrome

  const emptyHistory = await fetchTabHistorySnapshotResult()
  assert.equal(emptyHistory.ok, true)
  assert.equal(emptyHistory.value.maxSize, 48)
})

test('history client rejects malformed successful responses', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true, snapshot: {} })
    }
  } as unknown as typeof globalThis.chrome

  assert.equal((await fetchTabHistorySnapshotResult()).ok, false)
})
