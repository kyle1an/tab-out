import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SAVED_PAGES_STORAGE_KEY,
  loadSavedPagesStoreResult
} from '../src/extension/saved-pages.js'

test('Saved Pages loading distinguishes a rejected read from a valid empty first-run store', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => {
          throw new Error('Storage unavailable')
        }
      }
    }
  } as unknown as typeof globalThis.chrome

  const failed = await loadSavedPagesStoreResult()
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.value.pages, {})

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ [SAVED_PAGES_STORAGE_KEY]: undefined })
      }
    }
  } as unknown as typeof globalThis.chrome

  const firstRun = await loadSavedPagesStoreResult()
  assert.equal(firstRun.ok, true)
  assert.deepEqual(firstRun.value.pages, {})
})

test('Saved Pages loading rejects malformed stored state instead of treating it as an empty store', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ [SAVED_PAGES_STORAGE_KEY]: { version: 1, pages: [] } })
      }
    }
  } as unknown as typeof globalThis.chrome

  const result = await loadSavedPagesStoreResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.value.pages, {})
})
