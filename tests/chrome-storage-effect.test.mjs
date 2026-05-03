import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readChromeStorageValue,
  runChromeEffect,
  runChromeEffectBestEffort,
  writeChromeStorageValue
} from '../src/extension/background/chrome-storage-effect.js'

test('chrome storage Effect adapter reads and writes through the storage seam', async () => {
  const values = {}
  const storage = {
    async get(key) {
      return { [key]: values[key] }
    },
    async set(items) {
      Object.assign(values, items)
    }
  }

  await runChromeEffect(writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 }))

  assert.deepEqual(
    await runChromeEffect(readChromeStorageValue(storage, 'globalTabHistory')),
    { stack: [], index: -1 }
  )
})

test('chrome storage Effect adapter keeps best-effort writes non-throwing', async () => {
  const storage = {
    async set() {
      throw new Error('quota')
    }
  }

  await runChromeEffectBestEffort(writeChromeStorageValue(storage, 'globalTabHistory', { stack: [], index: -1 }))
})
