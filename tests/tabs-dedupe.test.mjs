import assert from 'node:assert/strict'
import test from 'node:test'

import { closeDuplicateTabs, fetchOpenTabs, openTabs } from '../extension/tabs.js'

function createChromeMock(initialTabs) {
  let tabs = initialTabs.map((tab) => ({ ...tab }))
  const removedIds = []

  globalThis.chrome = {
    runtime: {
      id: 'tab-out'
    },
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }))
      },
      async remove(tabIds) {
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

test('global dedupe preserves pinned Tab Out tabs while closing unpinned duplicates', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 }
  ])

  await closeDuplicateTabs([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
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
