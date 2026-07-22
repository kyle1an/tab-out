import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchDashboardServiceState,
  fetchDashboardServiceStateResult
} from '../src/extension/dashboard-service-state.js'

test('dashboard service state distinguishes a transport failure from valid empty state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        throw new Error('Service worker unavailable')
      }
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.value.tabHistory.entries, [])
  assert.deepEqual(result.value.workingSetActivity.records, {})
})

test('dashboard service state treats an explicit successful empty response as known state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: [{ id: 1, windowId: 1, url: 'https://example.test/' }],
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [], maxSize: 48 },
        workingSetActivity: { version: 1, records: {} }
      })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, true)
  assert.equal(result.value.tabHistory.maxSize, 48)
  assert.equal(result.value.openTabsSnapshot?.tabs[0]?.id, 1)
  assert.deepEqual(await fetchDashboardServiceState(), result.value)
})

test('dashboard service state rejects malformed successful responses instead of clearing known state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.value.tabHistory.entries, [])
  assert.deepEqual(result.value.workingSetActivity.records, {})
})

test('dashboard service state rejects otherwise-valid responses without an atomic open-tabs capture', async () => {
  for (const openTabsSnapshot of [undefined, { tabs: [] }, { windows: [] }]) {
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => ({
          ok: true,
          openTabsSnapshot,
          tabHistory: { entries: [], maxSize: 48 },
          workingSetActivity: { version: 1, records: {} }
        })
      }
    } as unknown as typeof globalThis.chrome

    const result = await fetchDashboardServiceStateResult()
    assert.equal(result.ok, false)
    assert.equal(result.value.openTabsSnapshot, null)
  }
})
