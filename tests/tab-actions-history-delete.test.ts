import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceDashboardRefreshForTesting } from '../src/extension/dashboard-intake.js'
import { deleteHistoryUrls, historyDeleteToastMessage } from '../src/extension/tab-actions.js'

test('deleteHistoryUrls preserves confirmed partial deletion and reports the requested count', async () => {
  const deletedUrls: string[] = []
  ;(globalThis as any).chrome = {
    history: {
      async deleteUrl({ url }: { url: string }) {
        if (url.endsWith('/unavailable')) throw new Error('History deletion unavailable')
        deletedUrls.push(url)
      }
    }
  }
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })

  try {
    const callbackResults: unknown[] = []
    const result = await deleteHistoryUrls({
      urls: ['https://example.test/deleted', 'https://example.test/unavailable'],
      onAfterDelete: (callbackResult) => {
        callbackResults.push(callbackResult)
      }
    })

    assert.deepEqual(result, { ok: false, deletedCount: 1 })
    assert.deepEqual(callbackResults, [result])
    assert.deepEqual(deletedUrls, ['https://example.test/deleted'])
    assert.equal(refreshCount, 1)
    assert.equal(historyDeleteToastMessage(1, 2), 'Deleted 1 of 2 history items')
  } finally {
    unregisterRefresh()
  }
})

test('historyDeleteToastMessage distinguishes zero, single, complete, and partial deletion', () => {
  assert.equal(historyDeleteToastMessage(0, 2), 'Could not delete history')
  assert.equal(historyDeleteToastMessage(1, 1), 'History deleted')
  assert.equal(historyDeleteToastMessage(2, 2), 'Deleted 2 history items')
  assert.equal(historyDeleteToastMessage(2, 3), 'Deleted 2 of 3 history items')
})
