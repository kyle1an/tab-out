import assert from 'node:assert/strict'
import test from 'node:test'

import { makeDashboardItem } from '../src/extension/dashboard-item.js'

test('makeDashboardItem: fills the read-only-item baseline and derives rawUrl from url', () => {
  const item = makeDashboardItem({ url: 'https://example.com/a', title: 'Example', sourceType: 'bookmark' })
  assert.equal(item.rawUrl, 'https://example.com/a')
  assert.equal(item.suspended, false)
  assert.equal(item.favIconUrl, '')
  assert.equal(item.windowId, 1)
  assert.equal(item.active, false)
  assert.equal(item.pinned, false)
  assert.equal(item.groupId, -1)
  assert.equal(item.isTabOut, false)
  assert.equal(item.isApp, false)
  assert.equal(item.sourceType, 'bookmark')
})

test('makeDashboardItem: explicit fields win over the baseline', () => {
  const item = makeDashboardItem({
    url: 'https://example.com/b',
    title: 'Saved',
    sourceType: 'saved-page',
    favIconUrl: 'https://example.com/icon.png',
    windowId: 0,
    saved: true,
    closedSaved: true,
    savedPageKey: 'https://example.com/b',
  })
  assert.equal(item.windowId, 0)
  assert.equal(item.favIconUrl, 'https://example.com/icon.png')
  assert.equal(item.saved, true)
  assert.equal(item.closedSaved, true)
  assert.equal(item.rawUrl, 'https://example.com/b')
})
