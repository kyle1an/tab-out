import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { refreshBadge } from '../src/extension/background/badge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import { createBackgroundRuntime } from '../src/extension/background/runtime.js'

function duplicateTabs(closableCount: number): chrome.tabs.Tab[] {
  return Array.from({ length: closableCount + 1 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: 'https://duplicate.example.test/',
    active: index === 0,
    groupId: -1
  })) as chrome.tabs.Tab[]
}

async function createBadgeRefresher(t: TestContext, chromeApi: ChromeApi): Promise<() => Promise<void>> {
  const runtime = createBackgroundRuntime(chromeApi)
  t.after(() => runtime.dispose())
  await runtime.context()
  return () => runtime.runPromise(refreshBadge)
}

test('badge refresh coalesces an event burst and never applies an overtaken count', async (t) => {
  const firstQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const latestQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const firstQueryStarted = Promise.withResolvers<void>()
  const latestQueryStarted = Promise.withResolvers<void>()
  const queries = [firstQuery, latestQuery]
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  let queryCount = 0
  const chromeApi = {
    tabs: {
      query: async () => {
        queryCount += 1
        if (queryCount === 1) firstQueryStarted.resolve()
        if (queryCount === 2) latestQueryStarted.resolve()
        const query = queries[queryCount - 1]
        assert.ok(query, 'unexpected badge tab query')
        return query.promise
      }
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) },
      setTitle: async ({ title }: { title: string }) => { badgeTitles.push(title) }
    }
  } as unknown as ChromeApi
  const refresh = await createBadgeRefresher(t, chromeApi)

  const firstRefresh = refresh()
  await firstQueryStarted.promise
  const secondRefresh = refresh()
  const thirdRefresh = refresh()
  assert.equal(queryCount, 1)

  firstQuery.resolve(duplicateTabs(1))
  await latestQueryStarted.promise

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, [])
  latestQuery.resolve(duplicateTabs(3))
  await Promise.all([firstRefresh, secondRefresh, thirdRefresh])

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['3'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 3 duplicate tabs'])
})

test('badge refresh skips redundant writes when the visible count and color are unchanged', async (t) => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  let queryCount = 0
  const chromeApi = {
    tabs: {
      query: async () => {
        queryCount += 1
        return duplicateTabs(2)
      }
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) },
      setTitle: async ({ title }: { title: string }) => { badgeTitles.push(title) }
    }
  } as unknown as ChromeApi
  const refresh = await createBadgeRefresher(t, chromeApi)

  await refresh()
  await refresh()

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['2'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 2 duplicate tabs'])
})

test('badge refresh preserves its last presentation when the tab read fails', async (t) => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  let shouldFail = false
  const chromeApi = {
    tabs: {
      query: async () => {
        if (shouldFail) throw new Error('Tabs unavailable')
        return duplicateTabs(4)
      }
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) },
      setTitle: async ({ title }: { title: string }) => { badgeTitles.push(title) }
    }
  } as unknown as ChromeApi
  const refresh = await createBadgeRefresher(t, chromeApi)

  await refresh()
  shouldFail = true
  await refresh()

  assert.deepEqual(badgeText, ['4'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 4 duplicate tabs'])
})

test('badge refresh retries a presentation whose text write failed', async (t) => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  let textWriteCount = 0
  const chromeApi = {
    tabs: {
      query: async () => duplicateTabs(5)
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        textWriteCount += 1
        if (textWriteCount === 1) throw new Error('Badge unavailable')
        badgeText.push(text)
      },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) },
      setTitle: async ({ title }: { title: string }) => { badgeTitles.push(title) }
    }
  } as unknown as ChromeApi
  const refresh = await createBadgeRefresher(t, chromeApi)

  await refresh()
  await refresh()

  assert.equal(textWriteCount, 2)
  assert.deepEqual(badgeText, ['5'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 5 duplicate tabs'])
})

test('badge hides at zero and explains that there is nothing to dedupe', async (t) => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  const chromeApi = {
    tabs: {
      query: async () => [
        { id: 1, windowId: 1, url: 'https://alpha.example.test/' },
        { id: 2, windowId: 1, url: 'https://bravo.example.test/' }
      ]
    },
    windows: {
      getCurrent: async () => ({ id: 1 })
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) },
      setTitle: async ({ title }: { title: string }) => { badgeTitles.push(title) }
    }
  } as unknown as ChromeApi

  const refresh = await createBadgeRefresher(t, chromeApi)
  await refresh()

  assert.deepEqual(badgeText, [''])
  assert.deepEqual(badgeColors, [])
  assert.deepEqual(badgeTitles, ['Tab Out: no duplicates to dedupe'])
})
