import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { runWithWebLock } from '../src/extension/web-lock.js'

test('runWithWebLock serializes same-name tasks through the browser lock manager', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  let markFirstStarted!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  const lockName = 'tab-out:test:exclusive-task'

  const first = runWithWebLock(lockName, async () => {
    order.push('first:start')
    markFirstStarted()
    await firstGate
    order.push('first:end')
    return 'first'
  })
  await firstStarted
  const second = runWithWebLock(lockName, async () => {
    order.push('second')
    return 'second'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(order, ['first:start'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('Chrome-only persistence code has no no-Web-Locks fallback queues', () => {
  const closedGhostDismissalsSource = readFileSync(new URL('../src/extension/closed-ghost-dismissals.ts', import.meta.url), 'utf8')
  const historyRangeSource = readFileSync(new URL('../src/extension/history-range.ts', import.meta.url), 'utf8')
  const savedPagesSource = readFileSync(new URL('../src/extension/saved-pages.ts', import.meta.url), 'utf8')
  const startupSnapshotSource = readFileSync(new URL('../src/extension/startup-snapshot.ts', import.meta.url), 'utf8')
  const storageListMutationsSource = readFileSync(new URL('../src/extension/storage-list-mutations.ts', import.meta.url), 'utf8')
  const suspensionSource = readFileSync(new URL('../src/extension/suspension.ts', import.meta.url), 'utf8')

  for (const source of [
    closedGhostDismissalsSource,
    historyRangeSource,
    savedPagesSource,
    startupSnapshotSource,
    storageListMutationsSource,
    suspensionSource
  ]) {
    assert.match(source, /runWithWebLock/)
    assert.doesNotMatch(source, /navigator\.locks|typeof navigator/)
  }

  assert.doesNotMatch(historyRangeSource, /fallbackQueue/)
  assert.match(suspensionSource, /runWithWebLock/)
  assert.doesNotMatch(suspensionSource, /suspendTargetSaveInFlight|pendingSuspendTargetSave/)
})
