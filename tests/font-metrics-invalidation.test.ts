import assert from 'node:assert/strict'
import test from 'node:test'

import { subscribeFontMetricsInvalidation } from '../src/components/font-metrics-invalidation.js'

class FakeFontSet {
  readonly listeners = new Map<string, Set<() => void>>()
  readonly ready = Promise.resolve(this)
  status: FontFaceSetLoadStatus = 'loaded'
  addCount = 0
  removeCount = 0

  addEventListener(type: string, listener: () => void): void {
    this.addCount += 1
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.removeCount += 1
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

test('font metric invalidation shares listeners and coalesces one settlement', async () => {
  const previousDocument = (globalThis as { document?: Document }).document
  const fontSet = new FakeFontSet()
  ;(globalThis as { document?: Document }).document = { fonts: fontSet } as unknown as Document
  let firstCalls = 0
  let secondCalls = 0

  try {
    const unsubscribeFirst = subscribeFontMetricsInvalidation(() => { firstCalls += 1 })
    const unsubscribeFailing = subscribeFontMetricsInvalidation(() => { throw new Error('stale measurement target') })
    const unsubscribeSecond = subscribeFontMetricsInvalidation(() => { secondCalls += 1 })

    assert.equal(fontSet.addCount, 2)
    fontSet.emit('loadingdone')
    fontSet.emit('loadingerror')
    await Promise.resolve()
    assert.deepEqual([firstCalls, secondCalls], [1, 1])

    unsubscribeFirst()
    assert.equal(fontSet.removeCount, 0)
    unsubscribeFailing()
    assert.equal(fontSet.removeCount, 0)
    unsubscribeSecond()
    assert.equal(fontSet.removeCount, 2)
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: Document }).document
    else (globalThis as { document?: Document }).document = previousDocument
  }
})
