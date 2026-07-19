import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readChromeStorageValue,
  writeChromeStorageValue,
  writeChromeStorageValueBestEffort
} from '../src/extension/background/chrome-storage.js'

test('chrome storage helpers read and write through the storage seam', async () => {
  const values: Record<string, any> = {}
  const storage = {
    async get(key: string) {
      return { [key]: values[key] }
    },
    async set(items: Record<string, any>) {
      Object.assign(values, items)
    }
  } as unknown as chrome.storage.StorageArea

  await writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 })

  assert.deepEqual(
    await readChromeStorageValue(storage, 'globalTabHistory'),
    { stack: [], index: -1 }
  )
})

test('chrome storage helpers keep best-effort writes non-throwing', async () => {
  const warnings: any[][] = []
  const originalWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args)
  }

  const storage = {
    async set() {
      throw new Error('quota')
    }
  } as unknown as chrome.storage.StorageArea

  try {
    await writeChromeStorageValueBestEffort(storage, 'globalTabHistory', { stack: [], index: -1 })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][0], 'Tab Out background best-effort storage write failed')
  assert.equal(warnings[0][1], 'globalTabHistory')
  assert.equal(warnings[0][2].message, 'quota')
})
