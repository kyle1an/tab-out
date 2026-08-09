import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeChromeTabToDashboardItem } from '../src/extension/dashboard-tab-normalization.js'

function chromeTab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 1,
    highlighted: false,
    active: true,
    pinned: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    title: 'Tab Out',
    favIconUrl: '',
    ...overrides,
  } as chrome.tabs.Tab
}

test('live Dashboard Item normalization uses adapter-supplied browser context', () => {
  const item = normalizeChromeTabToDashboardItem(
    chromeTab({
      url: 'chrome-extension://injected-id/index.html?focusFilter=1',
      status: 'loading',
      audible: true,
      mutedInfo: { muted: true },
    }),
    {
      runtimeId: 'injected-id',
      windowType: 'normal',
    },
  )

  assert.deepEqual(
    {
      isTabOut: item.isTabOut,
      isApp: item.isApp,
      status: item.status,
      audible: item.audible,
      muted: item.muted,
    },
    {
      isTabOut: true,
      isApp: false,
      status: 'loading',
      audible: true,
      muted: true,
    },
  )
})
