import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { replaceDashboardRefreshForTesting } from '../src/extension/dashboard-intake.js'
import { duplicateTabTarget, reloadTabTarget } from '../src/extension/tab-actions.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

type TabCommandCalls = {
  duplicate: number[]
  reload: number[]
}

function installFakeChrome(initialTabs: chrome.tabs.Tab[]) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls: TabCommandCalls = { duplicate: [], reload: [] }
  const api = createFakeChromeApi({ tabs, tabCommandLog: calls })
  const queryTabs = api.tabs.query.bind(api.tabs)
  let queryCount = 0
  api.tabs.query = async (queryInfo = {}) => {
    queryCount += 1
    return queryTabs(queryInfo)
  }
  setChromeTabsApi(api)

  return {
    calls,
    get queryCount() {
      return queryCount
    },
    restore() {
      setChromeTabsApi(null)
    },
    tabs,
  }
}

function fakeTab(id: number, url: string): chrome.tabs.Tab {
  return {
    id,
    url,
    title: `Tab ${id}`,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    index: id,
  } as chrome.tabs.Tab
}

test('reloadTabTarget reloads the exact represented tab from a duplicate set', async (t) => {
  const chromeMock = installFakeChrome([
    fakeTab(1, 'https://example.test/docs'),
    fakeTab(2, 'https://example.test/docs'),
  ])
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {})
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await reloadTabTarget({ tabId: 2, tabUrl: 'https://example.test/docs' }), true)
  assert.deepEqual(chromeMock.calls.reload, [2])
  assert.equal(chromeMock.queryCount, 0)
})

test('duplicateTabTarget duplicates the exact represented tab and refreshes the dashboard', async (t) => {
  const chromeMock = installFakeChrome([
    fakeTab(1, 'https://example.test/docs'),
    fakeTab(2, 'https://example.test/docs'),
  ])
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await duplicateTabTarget({ tabId: 2, tabUrl: 'https://example.test/docs' }), true)
  assert.deepEqual(chromeMock.calls.duplicate, [2])
  assert.equal(chromeMock.tabs.length, 3)
  assert.equal(refreshCount, 1)
  assert.equal(chromeMock.queryCount, 0)
})

test('tab menu actions can resolve a folded environment pill by effective URL', async (t) => {
  const suspendedUrl = 'chrome-extension://suspender/suspended.html#ttl=Docs&uri=https%3A%2F%2Fenv-alpha.example.test%2Fdocs'
  const chromeMock = installFakeChrome([fakeTab(3, suspendedUrl)])
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {})
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await reloadTabTarget({ tabUrl: 'https://env-alpha.example.test/docs' }), true)
  assert.deepEqual(chromeMock.calls.reload, [3])
})

test('tab menu actions do not fall through to a different duplicate when an exact tab is gone', async (t) => {
  const chromeMock = installFakeChrome([fakeTab(1, 'https://example.test/docs')])
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {})
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await duplicateTabTarget({ tabId: 2, tabUrl: 'https://example.test/docs' }), false)
  assert.deepEqual(chromeMock.calls.duplicate, [])
  assert.equal(chromeMock.tabs.length, 1)
})

test('tab menu actions reject a reused id whose current URL does not match the rendered target', async (t) => {
  const chromeMock = installFakeChrome([fakeTab(2, 'https://unrelated.example.test/')])
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {})
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await reloadTabTarget({ tabId: 2, tabUrl: 'https://expected.example.test/' }), false)
  assert.equal(await duplicateTabTarget({ tabId: 2, tabUrl: 'https://expected.example.test/' }), false)
  assert.deepEqual(chromeMock.calls.reload, [])
  assert.deepEqual(chromeMock.calls.duplicate, [])
})

test('URL-only tab menu actions report unknown when the live inventory cannot be read', async (t) => {
  const chromeMock = installFakeChrome([fakeTab(3, 'https://example.test/docs')])
  const api = createFakeChromeApi({ tabs: chromeMock.tabs, tabCommandLog: chromeMock.calls })
  api.tabs.query = async () => {
    throw new Error('Tab inventory unavailable')
  }
  setChromeTabsApi(api)
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  t.after(() => {
    unregisterRefresh()
    chromeMock.restore()
  })

  assert.equal(await reloadTabTarget({ tabUrl: 'https://example.test/docs' }), 'unknown')
  assert.equal(await duplicateTabTarget({ tabUrl: 'https://example.test/docs' }), 'unknown')
  assert.deepEqual(chromeMock.calls.reload, [])
  assert.deepEqual(chromeMock.calls.duplicate, [])
  assert.equal(refreshCount, 0)
})
