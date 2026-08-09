import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi, type ChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { fetchOpenTabsSnapshot, seedOpenTabsTitleHistory } from '../src/extension/tabs.js'
import { makeCachedSuspendedTab } from './helpers/suspended-tab.js'

const pageUrl = 'https://example.test/docs'

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
        favIconUrl: '',
      }],
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }],
    },
    tabGroups: {
      query: async () => [],
    },
  } as unknown as ChromeTabsApi

  setChromeTabsApi(api)
  t.after(() => setChromeTabsApi(null))

  seedOpenTabsTitleHistory([makeCachedSuspendedTab(pageUrl)])

  const [tab] = await fetchOpenTabsSnapshot()
  assert.equal(tab?.title, 'Example Docs')
  assert.equal(tab?.retainedSuspendedTitle, true)
})
