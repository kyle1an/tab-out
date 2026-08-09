import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect, ManagedRuntime } from 'effect'

import { BrowserTabs } from '../src/extension/browser-tabs-service.js'
import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

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

test('BrowserTabs resolves the live gateway on every Effect call', async (t) => {
  const runtime = ManagedRuntime.make(BrowserTabs.layer())
  runtime.runSync(Effect.void)
  t.after(async () => {
    setChromeTabsApi(null)
    await runtime.dispose()
  })
  const service = runtime.runSync(BrowserTabs)

  setChromeTabsApi(createFakeChromeApi({ tabs: [fakeTab(1, 'https://first.test/')] }))
  assert.deepEqual(
    (await runtime.runPromise(service.queryAllTabsResult())).value.map((tab) => tab.url),
    ['https://first.test/'],
  )

  setChromeTabsApi(createFakeChromeApi({ tabs: [
    fakeTab(2, 'https://second.test/'),
    fakeTab(3, 'https://third.test/'),
  ] }))
  assert.deepEqual(
    (await runtime.runPromise(service.queryAllTabsResult())).value.map((tab) => tab.url),
    ['https://second.test/', 'https://third.test/'],
  )
})
