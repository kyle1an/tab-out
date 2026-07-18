import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi, type ChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { fetchOpenTabsSnapshot, seedOpenTabsTitleHistory } from '../src/extension/tabs.js'
import type { DashboardTab } from '../src/extension/types'

const pageUrl = 'https://example.test/docs'

function cachedSuspendedTab(): DashboardTab {
  return {
    id: 7,
    url: pageUrl,
    rawUrl: `chrome-extension://suspender-id/suspended.html#ttl=Example%20Docs&uri=${pageUrl}`,
    suspended: true,
    title: 'Example Docs',
    status: 'complete',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    index: 0
  }
}

test('a cached suspended tab seeds title retention before the first live refresh', async (t) => {
  const api = {
    tabs: {
      query: async () => [{
        id: 7,
        url: pageUrl,
        title: 'Example',
        status: 'loading',
        windowId: 1,
        active: false,
        pinned: false,
        groupId: -1,
        index: 0,
        favIconUrl: ''
      }]
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }]
    },
    tabGroups: {
      query: async () => []
    }
  } as unknown as ChromeTabsApi

  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  seedOpenTabsTitleHistory([cachedSuspendedTab()])

  const [tab] = await fetchOpenTabsSnapshot()
  assert.equal(tab?.title, 'Example Docs')
  assert.equal(tab?.retainedSuspendedTitle, true)
})
