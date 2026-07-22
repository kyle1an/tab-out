import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchBookmarksSourceItemsResult } from '../src/extension/bookmarks.js'
import { fetchTabGroupColors, groupDotColor } from '../src/extension/groups.js'

test('bookmark reads distinguish a confirmed empty tree from a rejected read', async (t) => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  t.after(() => {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  })

  ;(globalThis as { chrome?: unknown }).chrome = {
    bookmarks: { getTree: async () => [] }
  }
  assert.deepEqual(await fetchBookmarksSourceItemsResult(), { ok: true, value: [] })

  ;(globalThis as { chrome?: unknown }).chrome = {
    bookmarks: { getTree: async () => { throw new Error('bookmark database unavailable') } }
  }
  assert.deepEqual(await fetchBookmarksSourceItemsResult(), { ok: false, value: [] })
})

test('tab-group color refresh preserves known colors when Chrome rejects the read', async (t) => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  t.after(() => {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  })

  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => [{ id: 7, color: 'red' }]
    }
  }
  assert.equal(await fetchTabGroupColors(), true)
  assert.equal(groupDotColor(7), '#D93025')

  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => { throw new Error('group metadata unavailable') }
    }
  }
  assert.equal(await fetchTabGroupColors(), false)
  assert.equal(groupDotColor(7), '#D93025')
})
