import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readChromeStorageValue,
  writeChromeStorageValue,
} from '../src/extension/background/chrome-storage.js'

test('chrome storage helpers read and write through the storage seam', async () => {
  const values: Record<string, any> = {}
  const storage = {
    async get(key: string) {
      return { [key]: values[key] }
    },
    async set(items: Record<string, any>) {
      Object.assign(values, items)
    },
  } as unknown as chrome.storage.StorageArea

  await writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 })

  assert.deepEqual(
    await readChromeStorageValue(storage, 'globalTabHistory'),
    { stack: [], index: -1 },
  )
})
