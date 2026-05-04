import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readChromeStorageValue,
  runChromeEffect,
  runChromeEffectBestEffort,
  writeChromeStorageValue
} from '../src/extension/background/chrome-storage-effect.js'

test('chrome storage Effect adapter reads and writes through the storage seam', async () => {
  const values: Record<string, any> = {}
  const storage = {
    async get(key: string) {
      return { [key]: values[key] }
    },
    async set(items: Record<string, any>) {
      Object.assign(values, items)
    }
  } as unknown as chrome.storage.StorageArea

  await runChromeEffect(writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 }))

  assert.deepEqual(
    await runChromeEffect(readChromeStorageValue(storage, 'globalTabHistory')),
    { stack: [], index: -1 }
  )
})

test('chrome storage Effect adapter keeps best-effort writes non-throwing', async () => {
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
    await runChromeEffectBestEffort(writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 }))
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][0], 'Tab Out background best-effort effect failed')
  assert.equal(warnings[0][1]._tag, 'ChromeStorageWriteError')
  assert.equal(warnings[0][1].key, 'globalTabHistory')
})
