import assert from 'node:assert/strict'
import test from 'node:test'

import { captureDomainCardFocusRecovery } from '../src/components/DomainCardFocusRecovery.js'

type FakeElement = {
  contains: (candidate: unknown) => boolean
  dataset: Record<string, string>
  focus: () => void
  isConnected: boolean
  ownerDocument: Document
  querySelector: (selector: string) => FakeElement | null
  closest: () => null
}

type FocusRecoveryHarness = {
  body: object
  capturedCard: FakeElement
  filterFocusCount: () => number
  notifyMutation: () => void
  observerDisconnected: () => boolean
  pendingFrameCount: () => number
  runNextFrame: () => void
  setActiveElement: (element: unknown) => void
  triggerFocusCount: () => number
}

function withFocusRecoveryHarness(
  assertions: (harness: FocusRecoveryHarness) => void,
) {
  const globalScope = globalThis as typeof globalThis & {
    MutationObserver?: typeof MutationObserver
    cancelAnimationFrame?: typeof cancelAnimationFrame
    requestAnimationFrame?: typeof requestAnimationFrame
  }
  const previousMutationObserver = globalScope.MutationObserver
  const previousCancelAnimationFrame = globalScope.cancelAnimationFrame
  const previousRequestAnimationFrame = globalScope.requestAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 1
  let observerCallback: MutationCallback = () => {
    assert.fail('expected focus recovery to install a mutation observer')
  }
  let observerDisconnected = false

  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      observerCallback = callback
    }

    disconnect() {
      observerDisconnected = true
    }

    observe() {}

    takeRecords(): MutationRecord[] {
      return []
    }
  }

  globalScope.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver
  globalScope.requestAnimationFrame = (callback) => {
    const frameId = nextFrameId
    nextFrameId += 1
    frames.set(frameId, callback)
    return frameId
  }
  globalScope.cancelAnimationFrame = (frameId) => {
    frames.delete(frameId)
  }

  function runNextFrame() {
    const entry = frames.entries().next().value
    assert.ok(entry)
    const [frameId, callback] = entry
    frames.delete(frameId)
    callback(0)
  }

  const body = {}
  const documentElement = {}
  const documentState: {
    activeElement: unknown
    filterFocusCount: number
    triggerFocusCount: number
  } = {
    activeElement: null,
    filterFocusCount: 0,
    triggerFocusCount: 0,
  }
  const ownerDocument = {
    activeElement: null,
    addEventListener() {},
    body,
    documentElement,
    querySelector: () => filterInput,
    removeEventListener() {},
    visibilityState: 'visible',
  } as unknown as Document
  const trigger = {
    contains: () => false,
    dataset: {},
    focus() {
      documentState.triggerFocusCount += 1
      documentState.activeElement = trigger
    },
    isConnected: true,
    ownerDocument,
    querySelector: () => null,
    closest: () => null,
  } satisfies FakeElement
  const filterInput = {
    contains: () => false,
    dataset: {},
    focus() {
      documentState.filterFocusCount += 1
      documentState.activeElement = filterInput
    },
    isConnected: true,
    ownerDocument,
    querySelector: () => null,
    closest: () => null,
  } satisfies FakeElement
  const capturedCard: FakeElement = {
    contains: (candidate: unknown) => candidate === trigger,
    dataset: { taboutDomain: 'example.test' },
    focus() {},
    isConnected: true,
    ownerDocument,
    querySelector: () => trigger,
    closest: () => null,
  }

  Object.defineProperty(ownerDocument, 'activeElement', {
    configurable: true,
    get: () => documentState.activeElement,
  })
  documentState.activeElement = trigger

  try {
    const startRecovery = captureDomainCardFocusRecovery(
      capturedCard as unknown as HTMLElement,
    )
    assert.ok(startRecovery)
    startRecovery()
    assertions({
      body,
      capturedCard,
      filterFocusCount: () => documentState.filterFocusCount,
      notifyMutation: () => observerCallback([], {} as MutationObserver),
      observerDisconnected: () => observerDisconnected,
      pendingFrameCount: () => frames.size,
      runNextFrame,
      setActiveElement: (element) => {
        documentState.activeElement = element
      },
      triggerFocusCount: () => documentState.triggerFocusCount,
    })
  } finally {
    if (previousMutationObserver) globalScope.MutationObserver = previousMutationObserver
    else delete globalScope.MutationObserver
    if (previousCancelAnimationFrame) globalScope.cancelAnimationFrame = previousCancelAnimationFrame
    else delete globalScope.cancelAnimationFrame
    if (previousRequestAnimationFrame) globalScope.requestAnimationFrame = previousRequestAnimationFrame
    else delete globalScope.requestAnimationFrame
  }
}

test('card focus recovery waits one frame for the captured card removal to commit', () => {
  withFocusRecoveryHarness((harness) => {
    harness.runNextFrame()

    assert.equal(harness.triggerFocusCount(), 0)
    assert.equal(harness.filterFocusCount(), 0)
    assert.equal(harness.observerDisconnected(), false)
    assert.equal(harness.pendingFrameCount(), 1)

    harness.capturedCard.isConnected = false
    harness.setActiveElement(harness.body)
    harness.notifyMutation()
    harness.runNextFrame()

    assert.equal(harness.triggerFocusCount(), 0)
    assert.equal(harness.filterFocusCount(), 1)
    assert.equal(harness.observerDisconnected(), true)
    assert.equal(harness.pendingFrameCount(), 0)
  })
})

test('card focus recovery accepts a surviving captured card on the second frame', () => {
  withFocusRecoveryHarness((harness) => {
    harness.runNextFrame()

    assert.equal(harness.triggerFocusCount(), 0)
    assert.equal(harness.pendingFrameCount(), 1)

    harness.runNextFrame()

    assert.equal(harness.triggerFocusCount(), 1)
    assert.equal(harness.filterFocusCount(), 0)
    assert.equal(harness.observerDisconnected(), true)
    assert.equal(harness.pendingFrameCount(), 0)
  })
})
