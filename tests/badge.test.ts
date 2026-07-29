import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { createBadgeRefreshService } from '../src/extension/background/badge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

function duplicateTabs(closableCount: number): chrome.tabs.Tab[] {
  return Array.from({ length: closableCount + 1 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: 'https://duplicate.example.test/',
    active: index === 0,
    groupId: -1
  })) as chrome.tabs.Tab[]
}

test('badge refresh coalesces an event burst and never applies an overtaken count', async () => {
  const firstQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const latestQuery = Promise.withResolvers<chrome.tabs.Tab[]>()
  const queries = [firstQuery, latestQuery]
  const badgeText: string[] = []
  const badgeColors: string[] = []
  const badgeTitles: string[] = []
  let queryCount = 0
  const chromeApi = {
    tabs: {
      query: async () => {
        const query = queries[queryCount++]
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
  const service = createBadgeRefreshService(chromeApi)

  const firstRefresh = service.refresh()
  const secondRefresh = service.refresh()
  const thirdRefresh = service.refresh()
  assert.equal(queryCount, 1)

  firstQuery.resolve(duplicateTabs(1))
  await setImmediate()

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, [])
  latestQuery.resolve(duplicateTabs(3))
  await Promise.all([firstRefresh, secondRefresh, thirdRefresh])

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['3'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 3 duplicate tabs'])
})

test('badge refresh skips redundant writes when the visible count and color are unchanged', async () => {
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
  const service = createBadgeRefreshService(chromeApi)

  await service.refresh()
  await service.refresh()

  assert.equal(queryCount, 2)
  assert.deepEqual(badgeText, ['2'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 2 duplicate tabs'])
})

test('badge refresh preserves its last presentation when the tab read fails', async () => {
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
  const service = createBadgeRefreshService(chromeApi)

  await service.refresh()
  shouldFail = true
  await service.refresh()

  assert.deepEqual(badgeText, ['4'])
  assert.deepEqual(badgeColors, ['#3d7a4a'])
  assert.deepEqual(badgeTitles, ['Dedupe 4 duplicate tabs'])
})

test('badge hides at zero and explains that there is nothing to dedupe', async () => {
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

  await createBadgeRefreshService(chromeApi).refresh()

  assert.deepEqual(badgeText, [''])
  assert.deepEqual(badgeColors, [])
  assert.deepEqual(badgeTitles, ['Tab Out: no duplicates to dedupe'])
})
