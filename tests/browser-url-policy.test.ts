import assert from 'node:assert/strict'
import test from 'node:test'

import { updateBadge } from '../src/extension/background/badge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import { isBrowserInternalUrl } from '../src/extension/browser-url-policy.js'
import { getDashboardTabsFromOpenTabs } from '../src/extension/tabs.js'
import type { DashboardTab } from '../src/extension/types'

test('browser URL policy classifies Chromium internal schemes without hiding files', () => {
  for (const url of [
    'about:blank',
    'brave://settings/',
    'chrome://settings/',
    'chrome-extension://example-id/index.html',
    'chrome-search://local-ntp/local-ntp.html',
    'chrome-untrusted://new-tab-page/one-google-bar',
    'devtools://devtools/bundled/inspector.html',
    'edge://settings/'
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

test('toolbar badge excludes every browser-internal protocol', async () => {
  const badgeText: string[] = []
  const chromeApi = {
    tabs: {
      query: async () => [
        { url: 'chrome-search://local-ntp/local-ntp.html' },
        { url: 'chrome-untrusted://new-tab-page/one-google-bar' },
        { url: 'devtools://devtools/bundled/inspector.html' },
        { url: 'file:///tmp/example.html' },
        { url: 'https://example.test/' }
      ]
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async () => {}
    }
  } as unknown as ChromeApi

  await updateBadge(chromeApi)

  assert.deepEqual(badgeText, ['2'])
})
