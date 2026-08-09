import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { closeHistoryEntry, makeHistoryEntry } from '../src/extension/tab-history.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

test('closing a Tab Out history row preserves its URL for Undo', async (t) => {
  const runtimeId = 'tab-out-fake-extension'
  const tabUrl = `chrome-extension://${runtimeId}/index.html`
  const tabs = [{
    id: 7,
    windowId: 1,
    index: 0,
    url: tabUrl,
    title: 'Tab Out',
    active: false,
    pinned: false,
    groupId: -1,
  }] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ runtimeId, tabs })
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof chrome
  setChromeTabsApi(api)
  t.after(() => {
    setChromeTabsApi(null)
    globalThis.chrome = previousChrome
  })

  const result = await closeHistoryEntry(makeHistoryEntry({
    tabId: 7,
    windowId: 1,
    title: 'Tab Out',
    url: tabUrl,
    rawUrl: tabUrl,
    displayUrl: 'Tab Out',
    favIconUrl: '',
    exists: true,
  }))

  assert.equal(result.status, 'closed')
  assert.equal(result.closed, true)
  assert.equal(tabs.length, 0)
  assert.deepEqual(result.snapshot.map((snapshot) => snapshot.url), [tabUrl])
})

test('history close reports a rejected removal without exposing an Undo snapshot', async (t) => {
  const tabUrl = 'https://example.test/docs'
  const tabs = [{
    id: 9,
    windowId: 1,
    index: 0,
    url: tabUrl,
    title: 'Docs',
    active: false,
    pinned: false,
    groupId: -1,
  }] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  api.tabs.remove = async () => {
    throw new Error('Tab is managed')
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof chrome
  setChromeTabsApi(api)
  t.after(() => {
    setChromeTabsApi(null)
    globalThis.chrome = previousChrome
  })

  const result = await closeHistoryEntry(makeHistoryEntry({
    tabId: 9,
    windowId: 1,
    title: 'Docs',
    url: tabUrl,
    rawUrl: tabUrl,
    displayUrl: 'example.test/docs',
    favIconUrl: '',
    exists: true,
  }))

  assert.deepEqual(result, { status: 'failed', closed: false, snapshot: [] })
  assert.deepEqual(tabs.map((tab) => tab.id), [9])
})
