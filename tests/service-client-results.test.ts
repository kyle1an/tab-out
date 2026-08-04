import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTabHistorySwitchDirection } from '../src/extension/runtime-messages.js'
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

  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: 1, snapshot: { entries: [] } })
    }
  } as unknown as typeof globalThis.chrome

  assert.equal((await fetchTabHistorySnapshotResult()).ok, false)
})

test('history switch messages preserve the previous-direction fallback', () => {
  assert.equal(parseTabHistorySwitchDirection({ type: 'tab-out:switch-tab-history' }), -1)
  assert.equal(parseTabHistorySwitchDirection({ type: 'tab-out:switch-tab-history', direction: 'invalid' }), -1)
  assert.equal(parseTabHistorySwitchDirection({ type: 'tab-out:switch-tab-history', direction: 1 }), 1)
  assert.equal(parseTabHistorySwitchDirection({ type: 'other-message', direction: 1 }), null)
})
