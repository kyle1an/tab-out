import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshBadge } from '../src/extension/background/badge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import { createBackgroundRuntime } from '../src/extension/background/runtime.js'
import { isBrowserInternalUrl } from '../src/extension/browser-url-policy.js'
import { getDashboardTabsFromOpenTabs } from '../src/extension/tabs.js'
import type { DashboardTab } from '../src/extension/types'

test('browser URL policy classifies Chrome internal schemes without hiding files', () => {
  for (const url of [
    'about:blank',
    'chrome://settings/',
    'chrome-extension://example-id/index.html',
    'chrome-search://local-ntp/local-ntp.html',
    'chrome-untrusted://new-tab-page/one-google-bar',
    'devtools://devtools/bundled/inspector.html'
  ]) {
    assert.equal(isBrowserInternalUrl(url), true, url)
  }
  assert.equal(isBrowserInternalUrl('file:///tmp/example.html'), false)
  assert.equal(isBrowserInternalUrl('https://example.test/'), false)
})

test('dashboard composition excludes internal schemes but retains its own Tab Out page', () => {
  const tabs = [
    { id: 1, url: 'chrome-search://local-ntp/local-ntp.html' },
    { id: 2, url: 'chrome-untrusted://new-tab-page/one-google-bar' },
    { id: 3, url: 'devtools://devtools/bundled/inspector.html' },
    { id: 4, url: 'file:///tmp/example.html' },
    { id: 5, url: 'https://example.test/' },
    { id: 6, url: 'chrome-extension://tab-out/index.html', isTabOut: true }
  ] as DashboardTab[]

  assert.deepEqual(getDashboardTabsFromOpenTabs(tabs).map((tab) => tab.id), [4, 5, 6])
})

test('toolbar badge counts duplicate extras while excluding every browser-internal protocol', async (t) => {
  const badgeText: string[] = []
  const urls = [
    'chrome-search://local-ntp/local-ntp.html',
    'chrome-untrusted://new-tab-page/one-google-bar',
    'devtools://devtools/bundled/inspector.html',
    'file:///tmp/example.html',
    'https://example.test/'
  ]
  const chromeApi = {
    tabs: {
      query: async () => urls.flatMap((url, urlIndex) => [0, 1].map((copyIndex) => ({
        id: urlIndex * 2 + copyIndex + 1,
        windowId: 1,
        url,
        groupId: -1
      })))
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
    }
  } as unknown as ChromeApi

  const runtime = createBackgroundRuntime(chromeApi)
  t.after(() => runtime.dispose())
  await runtime.runPromise(refreshBadge)

  assert.deepEqual(badgeText, ['2'])
})
