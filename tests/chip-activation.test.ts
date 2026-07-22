import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import {
  chipActivationMode,
  performDashboardItemActivation,
  shouldSuppressSelectionForGesture
} from '../src/extension/tab-activation.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

const MAC = 'MacIntel'
const WIN = 'Win32'

function liveTab(id: number, windowId: number, url: string): chrome.tabs.Tab {
  return { id, windowId, url } as chrome.tabs.Tab
}

test('chipActivationMode returns focus when there is no event', () => {
  assert.equal(chipActivationMode(undefined, MAC), 'focus')
  assert.equal(chipActivationMode(null, MAC), 'focus')
})

test('chipActivationMode treats a plain click as focus on every platform', () => {
  assert.equal(chipActivationMode({}, MAC), 'focus')
  assert.equal(chipActivationMode({}, WIN), 'focus')
})

test('chipActivationMode: Cmd-click brings the tab into the current window (background) on macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, MAC), 'bring-background')
})

test('chipActivationMode: Shift-click uses the new-window mode on every platform', () => {
  assert.equal(chipActivationMode({ shiftKey: true }, MAC), 'open-window')
  assert.equal(chipActivationMode({ shiftKey: true }, WIN), 'open-window')
})

test('chipActivationMode: Ctrl is not the primary modifier on macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, MAC), 'focus')
})

test('chipActivationMode: Ctrl-click brings the tab into the current window (background) off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, WIN), 'bring-background')
})

test('chipActivationMode: primary modifier plus Shift brings the tab in and switches (foreground)', () => {
  assert.equal(chipActivationMode({ metaKey: true, shiftKey: true }, MAC), 'bring-foreground')
  assert.equal(chipActivationMode({ ctrlKey: true, shiftKey: true }, WIN), 'bring-foreground')
})

test('chipActivationMode: Cmd is not the primary modifier off macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, WIN), 'focus')
})

test('chipActivationMode: holding both Cmd and Ctrl is ambiguous and stays focus', () => {
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, WIN), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true, shiftKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true, shiftKey: true }, WIN), 'focus')
})

test('shouldSuppressSelectionForGesture: a plain click keeps selection (so drag-select still works)', () => {
  assert.equal(shouldSuppressSelectionForGesture(undefined, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture(null, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, WIN), false)
})

test('shouldSuppressSelectionForGesture: special gestures suppress native selection on macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, MAC), true)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true, shiftKey: true }, MAC), true)
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, MAC), true)
})

test('shouldSuppressSelectionForGesture: special gestures suppress native selection off macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, WIN), true)
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true, shiftKey: true }, WIN), true)
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, WIN), true)
})

test('shouldSuppressSelectionForGesture: a wrong-platform primary modifier keeps selection', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, WIN), false)
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true, shiftKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true, shiftKey: true }, WIN), false)
})

test('modifier activation opens a missing target with the requested current-window focus state', async (t) => {
  const tabs: chrome.tabs.Tab[] = []
  setChromeTabsApi(createFakeChromeApi({ tabs }))
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('bring-background', {
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'handled')
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0]?.url, 'https://example.test/docs')
  assert.equal(tabs[0]?.active, false)
})

test('modifier activation does not open a duplicate when the tab inventory is unknown', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 2, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  api.tabs.query = async () => {
    throw new Error('tabs unavailable')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('bring-background', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'failed')
  assert.equal(tabs.length, 1)
})

test('modifier activation does not open a duplicate when the current window is unknown', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 2, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  api.windows.getCurrent = async () => {
    throw new Error('window unavailable')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('bring-background', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'failed')
  assert.equal(tabs.length, 1)
})

test('modifier activation does not open a duplicate when Chrome refuses the move', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 2, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  let moveAttempts = 0
  api.tabs.move = async () => {
    moveAttempts += 1
    throw new Error('move refused')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('bring-background', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'failed')
  assert.equal(moveAttempts, 1)
  assert.equal(tabs.length, 1)
})

test('foreground modifier activation reports failure when a same-window tab cannot be activated', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 1, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  let updateAttempts = 0
  api.tabs.update = async () => {
    updateAttempts += 1
    throw new Error('activation refused')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const result = await performDashboardItemActivation('bring-foreground', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(result, 'failed')
  assert.equal(updateAttempts, 1)
  assert.equal(tabs.length, 1)
})

test('Shift activation does not open a duplicate when the tab inventory is unknown', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 1, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  let createAttempts = 0
  api.tabs.query = async () => {
    throw new Error('tabs unavailable')
  }
  api.windows.create = async () => {
    createAttempts += 1
    throw new Error('unexpected create')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('open-window', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'failed')
  assert.equal(createAttempts, 0)
  assert.equal(tabs.length, 1)
})

test('Shift activation does not retry by URL when Chrome refuses to move the live tab', async (t) => {
  const tabs: chrome.tabs.Tab[] = [
    liveTab(7, 1, 'https://example.test/docs')
  ]
  const api = createFakeChromeApi({ tabs })
  const createRequests: chrome.windows.CreateData[] = []
  api.windows.create = async (request) => {
    createRequests.push({ ...request })
    throw new Error('create refused')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('open-window', {
    tabId: 7,
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, 'failed')
  assert.deepEqual(createRequests, [{ tabId: 7, focused: true, type: 'normal' }])
  assert.equal(tabs.length, 1)
})

test('modifier activation reports failure when Chrome refuses to create the fallback tab', async (t) => {
  const tabs: chrome.tabs.Tab[] = []
  const api = createFakeChromeApi({ tabs })
  api.tabs.create = async () => {
    throw new Error('create refused')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const result = await performDashboardItemActivation('bring-background', {
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(result, 'failed')
  assert.equal(tabs.length, 0)
})

test('new-window activation reports failure when Chrome refuses to create the fallback window', async (t) => {
  const tabs: chrome.tabs.Tab[] = []
  const api = createFakeChromeApi({ tabs })
  api.windows.create = async () => {
    throw new Error('window create refused')
  }
  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  const result = await performDashboardItemActivation(
    'open-window',
    { tabUrl: 'https://example.test/docs' },
    { moveExisting: false }
  )

  assert.equal(result, 'failed')
  assert.equal(tabs.length, 0)
})
