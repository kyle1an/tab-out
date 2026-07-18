import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi, type ChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { fetchOpenTabsSnapshot, normalizeChromeOpenTabs } from '../src/extension/tabs.js'
import type { DashboardTab } from '../src/extension/types'

function chromeTab(overrides: Partial<chrome.tabs.Tab> & Pick<chrome.tabs.Tab, 'url' | 'title' | 'status'>): chrome.tabs.Tab {
  return {
    id: 7,
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    index: 0,
    favIconUrl: '',
    ...overrides
  } as chrome.tabs.Tab
}

function normalize(tabs: chrome.tabs.Tab[], previousTabs: readonly DashboardTab[] = []): DashboardTab[] {
  return normalizeChromeOpenTabs({
    tabs,
    windows: [{ id: 1, type: 'normal' } as chrome.windows.Window]
  }, previousTabs)
}

test('waking a suspended page retains its title through every loading title update', async (t) => {
  const pageUrl = 'https://example.test/docs'
  let tabs = [
    chromeTab({
      url: `chrome-extension://suspender-id/suspended.html#ttl=Example%20Docs&uri=${pageUrl}`,
      title: 'Suspender placeholder',
      status: 'complete'
    })
  ]
  const api = {
    tabs: {
      query: async () => tabs
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

  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs')

  tabs = [chromeTab({ url: pageUrl, title: '', status: 'loading' })]
  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs')

  tabs = [chromeTab({ url: pageUrl, title: '\u200e', status: 'loading' })]
  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs')

  tabs = [chromeTab({ url: pageUrl, title: 'Example', status: 'loading' })]
  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs')

  tabs = [chromeTab({ url: pageUrl, title: 'Example Docs refreshed', status: 'loading' })]
  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs')

  tabs = [chromeTab({ url: pageUrl, title: 'Example Docs refreshed', status: 'complete' })]
  assert.equal((await fetchOpenTabsSnapshot())[0]?.title, 'Example Docs refreshed')
})

test('ordinary reloads and newly created tabs use their current loading title', () => {
  const pageUrl = 'https://example.test/docs'
  const [awakeTab] = normalize([
    chromeTab({ url: pageUrl, title: 'Example Docs', status: 'complete' })
  ])

  const [reloadingTab] = normalize([
    chromeTab({ url: pageUrl, title: 'Example', status: 'loading' })
  ], [awakeTab])
  const [newTab] = normalize([
    chromeTab({ id: 8, url: pageUrl, title: 'Example', status: 'loading' })
  ])

  assert.equal(reloadingTab.title, 'Example')
  assert.equal(reloadingTab.retainedSuspendedTitle, undefined)
  assert.equal(newTab.title, 'Example')
  assert.equal(newTab.retainedSuspendedTitle, undefined)
})

test('a redirect or non-loading state releases the retained suspended title', () => {
  const pageUrl = 'https://example.test/docs'
  const suspendedUrl = `chrome-extension://suspender-id/suspended.html#ttl=Example%20Docs&uri=${pageUrl}`
  const [suspendedTab] = normalize([
    chromeTab({ url: suspendedUrl, title: 'Suspender placeholder', status: 'complete' })
  ])
  const [loadingTab] = normalize([
    chromeTab({ url: pageUrl, title: 'Example', status: 'loading' })
  ], [suspendedTab])

  const [redirectedTab] = normalize([
    chromeTab({ url: 'https://login.example.test/', title: 'Sign in', status: 'loading' })
  ], [loadingTab])
  const [unloadedTab] = normalize([
    chromeTab({ url: pageUrl, title: 'Example', status: 'unloaded' })
  ], [loadingTab])

  assert.equal(redirectedTab.title, 'Sign in')
  assert.equal(redirectedTab.retainedSuspendedTitle, undefined)
  assert.equal(unloadedTab.title, 'Example')
  assert.equal(unloadedTab.retainedSuspendedTitle, undefined)
})

test('duplicate suspended tabs retain titles independently by numeric tab id', () => {
  const pageUrl = 'https://example.test/docs'
  const previousTabs = normalize([
    chromeTab({
      id: 7,
      url: `chrome-extension://suspender-id/suspended.html#ttl=First%20copy&uri=${pageUrl}`,
      title: 'Suspender placeholder',
      status: 'complete'
    }),
    chromeTab({
      id: 8,
      url: `chrome-extension://suspender-id/suspended.html#ttl=Second%20copy&uri=${pageUrl}`,
      title: 'Suspender placeholder',
      status: 'complete'
    })
  ])

  const loadingTabs = normalize([
    chromeTab({ id: 7, url: pageUrl, title: 'Example', status: 'loading' }),
    chromeTab({ id: 8, url: pageUrl, title: 'Example', status: 'loading' })
  ], previousTabs)

  assert.deepEqual(loadingTabs.map((tab) => tab.title), ['First copy', 'Second copy'])
})
