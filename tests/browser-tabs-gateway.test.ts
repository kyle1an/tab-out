import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTab,
  createTabWithFallbackUrl,
  duplicateTab,
  focusWindow,
  getAllWindows,
  getAllWindowsResult,
  getCurrentWindow,
  getCurrentWindowResult,
  getRecentlyClosed,
  getRecentlyClosedResult,
  getTab,
  groupTabs,
  moveTab,
  queryAllTabs,
  queryAllTabsResult,
  queryTabGroups,
  queryTabGroupsResult,
  reloadTab,
  removeTabs,
  requestExternalUnsuspend,
  setChromeTabsApi,
  updateTab
} from '../src/extension/browser-tabs-gateway.js'
import type { ChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

function fakeTab(id: number, url: string, extra: Record<string, unknown> = {}): chrome.tabs.Tab {
  return { id, url, title: `Tab ${id}`, favIconUrl: '', windowId: 1, active: false, pinned: false, groupId: -1, index: id, ...extra } as unknown as chrome.tabs.Tab
}

function withoutGlobalChrome() {
  const previous = (globalThis as { chrome?: unknown }).chrome
  delete (globalThis as { chrome?: unknown }).chrome
  return () => {
    if (previous !== undefined) (globalThis as { chrome?: unknown }).chrome = previous
    else delete (globalThis as { chrome?: unknown }).chrome
  }
}

test('gateway resolves the injected api before the global, and releases on null', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(() => {
    setChromeTabsApi(null)
    restoreGlobal()
  })

  const injected = createFakeChromeApi({ tabs: [fakeTab(1, 'https://injected.test/')] })
  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(2, 'https://global.test/')] })

  setChromeTabsApi(injected)
  assert.deepEqual((await queryAllTabs()).map((tab) => tab.url), ['https://injected.test/'])

  setChromeTabsApi(null)
  assert.deepEqual((await queryAllTabs()).map((tab) => tab.url), ['https://global.test/'])
})

test('gateway re-reads globalThis.chrome on every call — no module-load caching', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(restoreGlobal)

  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(1, 'https://first.test/')] })
  assert.equal((await queryAllTabs()).length, 1)

  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(2, 'https://second.test/'), fakeTab(3, 'https://third.test/')] })
  assert.deepEqual((await queryAllTabs()).map((tab) => tab.url), ['https://second.test/', 'https://third.test/'])
})

test('gateway never throws: missing global and rejecting apis normalize to empty values', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(() => {
    setChromeTabsApi(null)
    restoreGlobal()
  })

  assert.deepEqual(await queryAllTabs(), [])
  assert.deepEqual(await queryAllTabsResult(), { ok: false, value: [] })
  assert.equal(await getTab(1), null)
  assert.deepEqual(await removeTabs([1, 2]), [])
  assert.equal(await updateTab(1, { muted: true }), null)
  assert.equal(await createTab({ url: 'https://a.test/' }), null)
  assert.equal(await reloadTab(1), false)
  assert.equal(await duplicateTab(1), null)
  assert.equal(await groupTabs([1], 5), false)
  assert.equal(await moveTab(1, { index: 0 }), null)
  assert.deepEqual(await getAllWindows(), [])
  assert.deepEqual(await getAllWindowsResult(), { ok: false, value: [] })
  assert.equal(await getCurrentWindow(), null)
  assert.deepEqual(await getCurrentWindowResult(), { ok: false, value: null })
  assert.equal(await focusWindow(1), false)
  assert.deepEqual(await queryTabGroups(), [])
  assert.deepEqual(await queryTabGroupsResult(), { ok: true, value: [] })
  assert.deepEqual(await getRecentlyClosed(), [])
  assert.deepEqual(await getRecentlyClosedResult(), { ok: true, value: [] })

  const rejecting = {
    tabs: {
      query: async () => {
        throw new Error('boom')
      },
      get: async () => {
        throw new Error('boom')
      }
    }
  } as unknown as ChromeTabsApi
  setChromeTabsApi(rejecting)
  assert.deepEqual(await queryAllTabs(), [])
  assert.equal(await getTab(1), null)
})

test('collection read results distinguish Chrome rejection from confirmed empty state', async (t) => {
  t.after(() => setChromeTabsApi(null))
  setChromeTabsApi({
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => { throw new Error('group metadata unavailable') }
    },
    sessions: {
      getRecentlyClosed: async () => { throw new Error('sessions unavailable') }
    }
  } as unknown as ChromeTabsApi)

  assert.deepEqual(await queryTabGroupsResult(), { ok: false, value: [] })
  assert.deepEqual(await getRecentlyClosedResult(), { ok: false, value: [] })
})

test('reloadTab and duplicateTab normalize Chrome tab commands', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const calls = { duplicate: [] as number[], reload: [] as number[] }
  const api = {
    tabs: {
      query: async () => [],
      reload: async (tabId: number) => {
        calls.reload.push(tabId)
      },
      duplicate: async (tabId: number) => {
        calls.duplicate.push(tabId)
        return fakeTab(9, 'https://duplicate.test/')
      }
    }
  } as unknown as ChromeTabsApi
  setChromeTabsApi(api)

  assert.equal(await reloadTab(4), true)
  assert.equal((await duplicateTab(4))?.id, 9)
  assert.deepEqual(calls, { duplicate: [4], reload: [4] })

  setChromeTabsApi({
    tabs: {
      query: async () => [],
      reload: async () => {
        throw new Error('gone')
      },
      duplicate: async () => {
        throw new Error('gone')
      }
    }
  } as unknown as ChromeTabsApi)
  assert.equal(await reloadTab(4), false)
  assert.equal(await duplicateTab(4), null)
})

test('removeTabs falls back to per-id removal when the batch rejects, and reports the exact ids', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const removed: number[] = []
  const api = {
    tabs: {
      query: async () => [],
      remove: async (tabIds: number | number[]) => {
        if (Array.isArray(tabIds)) throw new Error('batch contains a missing tab')
        if (tabIds === 2) throw new Error('already gone')
        removed.push(tabIds)
      }
    }
  } as unknown as ChromeTabsApi
  setChromeTabsApi(api)

  assert.deepEqual(await removeTabs([1, 2, 3]), [1, 3])
  assert.deepEqual(removed, [1, 3])
})

test('removeTabs mutates fake state in place and returns the batch ids', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const tabs = [fakeTab(1, 'https://a.test/'), fakeTab(2, 'https://b.test/'), fakeTab(3, 'https://c.test/')]
  setChromeTabsApi(createFakeChromeApi({ tabs }))

  assert.deepEqual(await removeTabs([1, 3]), [1, 3])
  assert.deepEqual(tabs.map((tab) => tab.id), [2])
})

test('createTabWithFallbackUrl retries the effective url when the raw url is refused', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const created: string[] = []
  const api = {
    tabs: {
      query: async () => [],
      create: async (props: chrome.tabs.CreateProperties) => {
        if (props.url?.startsWith('chrome-extension://')) throw new Error('refused')
        created.push(props.url || '')
        return fakeTab(9, props.url || '')
      }
    }
  } as unknown as ChromeTabsApi
  setChromeTabsApi(api)

  const restored = await createTabWithFallbackUrl({ url: 'chrome-extension://suspender/suspended.html#uri=https://page.test/' }, 'https://page.test/')
  assert.equal(restored?.url, 'https://page.test/')
  assert.deepEqual(created, ['https://page.test/'])

  const bothRefused = await createTabWithFallbackUrl({ url: 'chrome-extension://suspender/a' }, 'chrome-extension://suspender/a')
  assert.equal(bothRefused, null)
})

test('groupTabs guards a missing tabs.group and reports success through the fake', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const withoutGroup = { tabs: { query: async () => [] } } as unknown as ChromeTabsApi
  setChromeTabsApi(withoutGroup)
  assert.equal(await groupTabs([1], 7), false)

  const tabs = [fakeTab(1, 'https://a.test/')]
  setChromeTabsApi(createFakeChromeApi({ tabs }))
  assert.equal(await groupTabs([1], 7), true)
  assert.equal(tabs[0]?.groupId, 7)
})

test('requestExternalUnsuspend refuses self, missing messaging, and suspender errors', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const messages: Array<{ extensionId: string; message: unknown }> = []
  const apiWith = (response: unknown, id = 'tab-out-self') =>
    ({
      tabs: { query: async () => [] },
      runtime: {
        id,
        sendMessage: async (extensionId: string, message: unknown) => {
          messages.push({ extensionId, message })
          return response
        }
      }
    }) as unknown as ChromeTabsApi

  setChromeTabsApi(apiWith('done'))
  assert.equal(await requestExternalUnsuspend('tab-out-self', 3), false)
  assert.equal(messages.length, 0)

  assert.equal(await requestExternalUnsuspend('other-suspender', 3), true)
  assert.deepEqual(messages, [{ extensionId: 'other-suspender', message: { action: 'unsuspend', tabId: 3 } }])

  setChromeTabsApi(apiWith('Error: no such tab'))
  assert.equal(await requestExternalUnsuspend('other-suspender', 3), false)
})

test('fake windows and sessions back the read ops', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const windows = [
    { id: 1, type: 'normal', focused: false },
    { id: 2, type: 'normal', focused: true }
  ] as chrome.windows.Window[]
  setChromeTabsApi(
    createFakeChromeApi({
      windows,
      recentlyClosed: [{ lastModified: 1, tab: fakeTab(4, 'https://closed.test/') } as unknown as chrome.sessions.Session]
    })
  )

  assert.equal((await getCurrentWindow())?.id, 2)
  assert.equal(await focusWindow(1), true)
  assert.equal(windows[0]?.focused, true)
  assert.equal(windows[1]?.focused, false)
  assert.equal((await getRecentlyClosed()).length, 1)
})
