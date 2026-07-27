import assert from 'node:assert/strict'
import test from 'node:test'

import { createBadgeRefreshService } from '../src/extension/background/badge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

function webTabs(count: number): chrome.tabs.Tab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: `https://page-${index + 1}.example.test/`
  })) as chrome.tabs.Tab[]
}

test('badge refresh coalesces an event burst and never applies an overtaken count', async () => {
  const firstQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const latestQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const queries = [firstQuery, latestQuery]
  const badgeText: string[] = []
  const badgeColors: string[] = []
  let queryCount = 0
  const chromeApi = {
    tabs: {
      query: async () => {
        const query = queries[queryCount++]
        assert.ok(query, 'unexpected badge tab query')
        return query.promise
      }
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) }
    }
  } as unknown as ChromeApi
  const service = createBadgeRefreshService(chromeApi)

  const firstRefresh = service.refresh()
  const secondRefresh = service.refresh()
  const thirdRefresh = service.refresh()
  assert.equal(queryCount, 1)

  firstQuery.resolve(webTabs(1))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, [])
  latestQuery.resolve(webTabs(3))
  await Promise.all([firstRefresh, secondRefresh, thirdRefresh])

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['3'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
})

test('badge refresh skips redundant writes when the visible count and color are unchanged', async () => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  let queryCount = 0
  const chromeApi = {
    tabs: {
      query: async () => {
        queryCount += 1
        return webTabs(2)
      }
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) }
    }
  } as unknown as ChromeApi
  const service = createBadgeRefreshService(chromeApi)

  await service.refresh()
  await service.refresh()

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['2'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
})

test('badge refresh preserves its last presentation when the tab read fails', async () => {
  const badgeText: string[] = []
  const badgeColors: string[] = []
  let shouldFail = false
  const chromeApi = {
    tabs: {
      query: async () => {
        if (shouldFail) throw new Error('Tabs unavailable')
        return webTabs(4)
      }
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => { badgeText.push(text) },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badgeColors.push(color) }
    }
  } as unknown as ChromeApi
  const service = createBadgeRefreshService(chromeApi)

  await service.refresh()
  shouldFail = true
  await service.refresh()

  assert.deepEqual(badgeText, ['4'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
})
