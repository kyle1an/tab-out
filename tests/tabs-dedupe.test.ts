import assert from 'node:assert/strict'
import test from 'node:test'

import { countClosableDuplicateExtras, pickDuplicateTabsToClose } from '../src/extension/tab-dedupe-policy.js'
import { closeDuplicateTabs, closeDuplicateTabsResult, fetchOpenTabs, openTabs } from '../src/extension/tabs.js'

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
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return { ...tab }
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

test('dedupe keeps the most recently touched copy among ungrouped duplicates', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, lastAccessed: 300 },
    { id: 3, url, windowId: 1, index: 2, lastAccessed: 200 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [1, 3]
  )
})

test('a grouped duplicate is kept over a more recently touched ungrouped one', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, groupId: 7, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, groupId: -1, lastAccessed: 999 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [2]
  )
})

test('a pinned duplicate is kept over a more recently touched unpinned one', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, pinned: true, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, pinned: false, lastAccessed: 999 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [2]
  )
})

test('a more recently touched background copy is kept over one active in another window', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 2, index: 5, active: true, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 0, active: false, lastAccessed: 999 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, { currentWindowId: 1 }).map((tab) => tab.id),
    [1]
  )
})

test('tab id breaks recency ties so the newer-opened duplicate is kept', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 10, url, windowId: 1, index: 0 },
    { id: 20, url, windowId: 1, index: 1 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [10]
  )
})

test('a duplicate with a recorded lastAccessed is kept over one missing it (e.g. discarded)', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0 },
    { id: 2, url, windowId: 1, index: 1, lastAccessed: 500 }
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [1]
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

test('global dedupe aborts for Tab Out pages when current-window identity is unavailable', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    throw new Error('Current window disappeared')
  }

  const snapshot = await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [])
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

test('dedupe snapshots a confirmed Tab Out close independently of its preservation policy', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Current Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Sibling Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 }
  ])

  const result = await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: false })

  assert.equal(result.ok, true)
  assert.equal(result.removedCount, 1)
  assert.deepEqual(result.value.map((tab) => ({ url: tab.url, title: tab.title })), [
    { url: tabOutUrl, title: 'Sibling Tab Out' }
  ])
})

test('closeDuplicateTabsResult reports a partial duplicate close with confirmed snapshots', async () => {
  const url = 'https://example.test/docs'
  createChromeMock([
    { id: 1, url, title: 'Oldest', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 2, url, title: 'Middle', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
    { id: 3, url, title: 'Newest', windowId: 1, index: 2, active: true, pinned: false, groupId: -1, lastAccessed: 300 }
  ])
  const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
    if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
    if (tabIds === 1) throw new Error('Tab is managed')
    await removeTab(tabIds)
  }

  const result = await closeDuplicateTabsResult([url])

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  assert.equal(result.attemptedCount, 2)
  assert.equal(result.removedCount, 1)
  assert.equal(result.failedCount, 1)
  assert.deepEqual(result.value.map((tab) => tab.title), ['Middle'])
})

test('global dedupe does not close a tab whose pending navigation left the duplicate URL', async () => {
  const url = 'https://example.test/docs'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Newest', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
    { id: 2, url, pendingUrl: 'https://example.test/other', title: 'Leaving', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 3, url, title: 'Middle', windowId: 1, index: 2, active: false, pinned: false, groupId: -1, lastAccessed: 200 }
  ])

  const result = await closeDuplicateTabsResult([url])

  assert.equal(result.removedCount, 1)
  assert.deepEqual(removedIds, [3])
})

test('global dedupe reads tabs after current-window state settles', async () => {
  const url = 'https://example.test/docs'
  const pendingUrl = 'https://example.test/other'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Current', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
    { id: 2, url, title: 'Leaving', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 100 }
  ])
  let releaseCurrentWindow!: () => void
  const currentWindowGate = new Promise<void>((resolve) => {
    releaseCurrentWindow = resolve
  })
  let navigationStarted = false
  let tabQueryCount = 0
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1 }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    tabQueryCount += 1
    return [
      { id: 1, url, title: 'Current', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
      {
        id: 2,
        url,
        ...(navigationStarted ? { pendingUrl } : {}),
        title: 'Leaving',
        windowId: 1,
        index: 1,
        active: false,
        pinned: false,
        groupId: -1,
        lastAccessed: 100
      }
    ]
  }

  const resultPromise = closeDuplicateTabsResult([url])
  await Promise.resolve()

  assert.equal(tabQueryCount, 0)
  releaseCurrentWindow()
  const result = await resultPromise

  assert.equal(tabQueryCount, 1)
  assert.equal(result.removedCount, 0)
  assert.deepEqual(removedIds, [])
})

test('global dedupe indexes each live tab once when many keys are requested', async () => {
  const tabCount = 240
  const urls = Array.from({ length: tabCount }, (_, index) => `https://example.test/page-${index}`)
  let queryCount = 0
  let urlReadCount = 0
  const tabs = urls.map((url, index) => new Proxy({
    id: index + 1,
    url,
    title: `Page ${index}`,
    windowId: 1,
    index,
    active: index === 0,
    pinned: false,
    groupId: -1
  }, {
    get(target, property, receiver) {
      if (property === 'url') urlReadCount += 1
      return Reflect.get(target, property, receiver)
    }
  }))
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out' },
    tabs: {
      async query() {
        queryCount += 1
        return tabs
      },
      async remove() {}
    },
    windows: {
      async getCurrent() {
        return { id: 1 }
      }
    }
  }

  const result = await closeDuplicateTabsResult(urls)

  assert.equal(result.attemptedCount, 0)
  assert.equal(queryCount, 1)
  assert.equal(urlReadCount, tabCount)
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

test('global dedupe collapses dashboards with different filter params, keeping the active one', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 1, index: 1, active: false, pinned: false, groupId: -1 },
    { id: 3, url: base, title: 'Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds.slice().sort((a, b) => a - b), [2, 3])
})

test('global dedupe preserves a pinned dashboard even when filters differ', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
})

test('closeDuplicateTabs accepts a non-canonical requested URL for equivalent Jira comments', async () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const { removedIds } = createChromeMock([
    { id: 1, url: longForm, title: 'ABC-123', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 2, url: shortForm, title: 'ABC-123', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 }
  ])

  await closeDuplicateTabs([longForm], true)

  assert.deepEqual(removedIds, [1])
})

test('closeDuplicateTabs treats GitHub repository root slash variants as duplicates while keeping the active tab', async () => {
  const repository = 'https://github.com/example/repo'
  const { removedIds } = createChromeMock([
    { id: 1, url: repository, title: 'example/repo', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
    { id: 2, url: `${repository}/`, title: 'example/repo', windowId: 1, index: 1, active: true, pinned: false, groupId: -1, lastAccessed: 100 }
  ])

  await closeDuplicateTabs([`${repository}/`], true)

  assert.deepEqual(removedIds, [1])
})
