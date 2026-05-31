import assert from 'node:assert/strict'
import test from 'node:test'

import { countClosableDuplicateExtras, pickDuplicateTabsToClose } from '../src/extension/tab-dedupe-policy.js'
import { closeDuplicateTabs, fetchOpenTabs, openTabs } from '../src/extension/tabs.js'

function createChromeMock(initialTabs: any[]) {
  let tabs = initialTabs.map((tab) => ({ ...tab }))
  const removedIds: number[] = []

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out'
    },
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }))
      },
      async remove(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        removedIds.push(...ids)
        tabs = tabs.filter((tab) => !ids.includes(tab.id))
      }
    },
    windows: {
      async getCurrent() {
        return { id: 1 }
      },
      async getAll() {
        return [{ id: 1, type: 'normal' }]
      }
    }
  }

  return { removedIds }
}

test('dedupe policy counts only safe close extras for grouped duplicate tabs', () => {
  const sameGroup = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: 7 }
  ]
  const multiGroup = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: 8 }
  ]
  const mixed = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: -1 }
  ]

  assert.equal(countClosableDuplicateExtras(sameGroup), 1)
  assert.equal(countClosableDuplicateExtras(multiGroup), 0)
  assert.equal(countClosableDuplicateExtras(mixed), 1)
})

test('dedupe policy preserves pinned Tab Out copies before score-based selection', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const matching = [
    { id: 1, url: tabOutUrl, windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, windowId: 1, index: 1, active: true, pinned: false, groupId: -1 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, {
      preservePinnedTabOut: true,
      isTabOutUrl: (url) => url === tabOutUrl
    }).map((tab) => tab.id),
    [2]
  )
})

test('dedupe policy preserves pinned and grouped Tab Out buckets while closing ordinary extras', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const matching = [
    { id: 1, url: tabOutUrl, windowId: 1, index: 0, active: true, pinned: true, groupId: 7 },
    { id: 2, url: tabOutUrl, windowId: 1, index: 1, active: false, pinned: true, groupId: -1 },
    { id: 3, url: tabOutUrl, windowId: 1, index: 2, active: false, pinned: false, groupId: 7 },
    { id: 4, url: tabOutUrl, windowId: 1, index: 3, active: false, pinned: false, groupId: 7 },
    { id: 5, url: tabOutUrl, windowId: 1, index: 4, active: false, pinned: false, groupId: 8 },
    { id: 6, url: tabOutUrl, windowId: 1, index: 5, active: false, pinned: false, groupId: -1 },
    { id: 7, url: tabOutUrl, windowId: 1, index: 6, active: false, pinned: false, groupId: -1 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, {
      currentWindowId: 1,
      preservePinnedTabOut: true,
      isTabOutUrl: (url) => url === tabOutUrl
    }).map((tab) => tab.id),
    [6, 7]
  )
  assert.equal(
    countClosableDuplicateExtras(matching, {
      isTabOutGroup: true,
      currentWindowId: 1,
      isTabOutUrl: (url) => url === tabOutUrl
    }),
    2
  )
})

test('global dedupe keeps the current Tab Out tab when a pinned duplicate exists', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [])
})

test('global dedupe preserves pinned Tab Out tabs while closing non-current unpinned duplicates', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
})

test('global dedupe keeps the current Tab Out tab when a grouped duplicate exists', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: false, groupId: 7 }
  ])

  await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [])
})

test('global dedupe returns an undo snapshot for closed Tab Out duplicates', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  const snapshot = await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [
    {
      url: tabOutUrl,
      rawUrl: tabOutUrl,
      title: 'Tab Out',
      pinned: false,
      groupId: -1,
      windowId: 2,
      index: 1
    }
  ])
})

test('global dedupe returns an undo snapshot for closed native new-tab duplicates', async () => {
  const newTabUrl = 'chrome://newtab/'
  createChromeMock([
    { id: 1, url: newTabUrl, title: 'New Tab', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: newTabUrl, title: 'New Tab', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  const snapshot = await closeDuplicateTabs([newTabUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [
    {
      url: newTabUrl,
      rawUrl: newTabUrl,
      title: 'New Tab',
      pinned: false,
      groupId: -1,
      windowId: 2,
      index: 1
    }
  ])
})

test('global dedupe does not preserve pinned non-Tab-Out tabs with the Tab Out-only option', async () => {
  const url = 'https://example.com/dashboard'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Example', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url, title: 'Example', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([url], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [1])
})

test('fetchOpenTabs recognizes filter-focus dashboard URLs as Tab Out pages', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html?focusFilter=1'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 }
  ])

  await fetchOpenTabs()

  assert.equal(openTabs.length, 1)
  assert.equal(openTabs[0].rawUrl, tabOutUrl)
  assert.equal(openTabs[0].isTabOut, true)
})
