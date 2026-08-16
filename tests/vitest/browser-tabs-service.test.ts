import { assert, layer } from '@effect/vitest'
import { Effect } from 'effect'

import { BrowserTabs } from '../../src/extension/browser-tabs-service.js'
import { setChromeTabsApi } from '../../src/extension/browser-tabs-gateway.js'
import { makeChromeTab } from '../helpers/chrome-tab.js'
import { createFakeChromeApi } from '../helpers/fake-chrome.mjs'

function fakeTab(id: number, url: string): chrome.tabs.Tab {
  return makeChromeTab(id, url, `Tab ${id}`)
}

layer(BrowserTabs.layer())('BrowserTabs', (it) => {
  it.effect('resolves the live gateway on every Effect call', () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
      const service = yield* BrowserTabs

      setChromeTabsApi(createFakeChromeApi({ tabs: [fakeTab(1, 'https://first.test/')] }))
      assert.deepStrictEqual(
        (yield* service.queryAllTabsResult()).value.map((tab) => tab.url),
        ['https://first.test/'],
      )

      setChromeTabsApi(createFakeChromeApi({ tabs: [
        fakeTab(2, 'https://second.test/'),
        fakeTab(3, 'https://third.test/'),
      ] }))
      assert.deepStrictEqual(
        (yield* service.queryAllTabsResult()).value.map((tab) => tab.url),
        ['https://second.test/', 'https://third.test/'],
      )
    }))
})
