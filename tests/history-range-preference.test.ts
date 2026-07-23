import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHistoryRangePreferenceWriter,
  HISTORY_RANGE_STORAGE_KEY,
  loadHistoryRangePreference,
  saveHistoryRangePreference
} from '../src/extension/history-range.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

function createExclusiveRunner() {
  let queue = Promise.resolve()
  return function runExclusive<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = queue.then(task)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

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

test('rapid history range changes persist in invocation order even when the first write is slow', async () => {
  let releaseFirstWrite!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const writes: string[] = []
  let calls = 0
  const writer = createHistoryRangePreferenceWriter({
    async write(value) {
      calls += 1
      if (calls === 1) await firstWrite
      writes.push(value)
    },
    runExclusive: createExclusiveRunner()
  })

  const first = writer.save('30d')
  const second = writer.save('off')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const callsWhileFirstWriteWasBlocked = calls
  releaseFirstWrite()
  await Promise.all([first, second])
  assert.equal(callsWhileFirstWriteWasBlocked, 1)
  assert.deepEqual(writes, ['30d', 'off'])
})

test('independent page writers cannot let an older delayed range overwrite a newer choice', async () => {
  let releaseFirstWrite!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const writes: string[] = []
  let stored = '1d'
  let calls = 0
  const adapter = {
    async write(value: string) {
      calls += 1
      if (calls === 1) await firstWrite
      stored = value
      writes.push(value)
    },
    runExclusive: createExclusiveRunner()
  }
  const firstPageWriter = createHistoryRangePreferenceWriter(adapter)
  const secondPageWriter = createHistoryRangePreferenceWriter(adapter)

  const olderSave = firstPageWriter.save('30d')
  const newerSave = secondPageWriter.save('off')
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(calls, 1)
  releaseFirstWrite()
  await Promise.all([olderSave, newerSave])

  assert.deepEqual(writes, ['30d', 'off'])
  assert.equal(stored, 'off')
})
