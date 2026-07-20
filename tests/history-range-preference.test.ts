import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HISTORY_RANGE_STORAGE_KEY,
  loadHistoryRangePreference,
  saveHistoryRangePreference
} from '../src/extension/history-range.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

test('history range preference restores a valid saved scope', async () => {
  const previousChrome = globalThis.chrome
  globalThis.chrome = createFakeChromeApi({
    storageSeed: {
      [HISTORY_RANGE_STORAGE_KEY]: '90d'
    }
  }) as unknown as typeof chrome

  try {
    assert.equal(await loadHistoryRangePreference(), '90d')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('history range preference falls back to Last day for an invalid saved scope', async () => {
  const previousChrome = globalThis.chrome
  globalThis.chrome = createFakeChromeApi({
    storageSeed: {
      [HISTORY_RANGE_STORAGE_KEY]: '14d'
    }
  }) as unknown as typeof chrome

  try {
    assert.equal(await loadHistoryRangePreference(), '1d')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('history range preference falls back to Last day when extension storage is unavailable', async () => {
  const previousChrome = globalThis.chrome
  delete (globalThis as { chrome?: typeof chrome }).chrome

  try {
    assert.equal(await loadHistoryRangePreference(), '1d')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('history range preference falls back to Last day when storage cannot be read', async () => {
  const previousChrome = globalThis.chrome
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          throw new Error('storage unavailable')
        }
      }
    }
  } as unknown as typeof chrome

  try {
    assert.equal(await loadHistoryRangePreference(), '1d')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('history range preference remembers History off', async () => {
  const previousChrome = globalThis.chrome
  globalThis.chrome = createFakeChromeApi() as unknown as typeof chrome

  try {
    await saveHistoryRangePreference('off')
    assert.equal(await loadHistoryRangePreference(), 'off')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('history range preference can change for the current page when extension storage is unavailable', async () => {
  const previousChrome = globalThis.chrome
  delete (globalThis as { chrome?: typeof chrome }).chrome

  try {
    await assert.doesNotReject(saveHistoryRangePreference('30d'))
  } finally {
    globalThis.chrome = previousChrome
  }
})
