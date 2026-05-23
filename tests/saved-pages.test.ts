import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSavedPageToStore,
  emptySavedPagesStore,
  isSavedPageEligible,
  mergeSavedPagesWithTabs,
  normalizeSavedPagesStore,
  savedPageKeyForUrl,
  savedPagesStoresEqual
} from '../src/extension/saved-pages.js'
import type { DashboardTab } from '../src/extension/types'

function makeTab(overrides: Partial<DashboardTab> & { url: string }): DashboardTab {
  return {
    id: 1,
    url: overrides.url,
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: overrides.title || '',
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: false,
    index: overrides.index,
    ...overrides
  }
}

test('savedPageKeyForUrl preserves meaningful query and hash in the saved page identity', () => {
  assert.equal(
    savedPageKeyForUrl('https://example.test/docs?panel=reviews#comment-7'),
    'https://example.test/docs?panel=reviews#comment-7'
  )
})

test('isSavedPageEligible excludes browser utility pages and standalone apps', () => {
  assert.equal(isSavedPageEligible({ url: 'https://example.test/docs' }), true)
  assert.equal(isSavedPageEligible({ url: 'chrome://settings/' }), false)
  assert.equal(isSavedPageEligible({ url: 'chrome-extension://tab-out/index.html' }), false)
  assert.equal(isSavedPageEligible({ url: 'https://mail.example.test/', isApp: true }), false)
  assert.equal(isSavedPageEligible({ url: 'chrome://newtab/', isTabOut: true }), false)
})

test('normalizeSavedPagesStore keeps valid records and drops invalid ones', () => {
  const normalized = normalizeSavedPagesStore({
    version: 1,
    pages: {
      'https://example.test/docs': {
        key: 'https://example.test/docs',
        url: 'https://example.test/docs',
        title: 'Docs',
        favIconUrl: 'https://example.test/favicon.ico',
        savedAt: 10,
        updatedAt: 11
      },
      'chrome://settings/': {
        key: 'chrome://settings/',
        url: 'chrome://settings/',
        title: 'Settings',
        savedAt: 12,
        updatedAt: 13
      }
    }
  })

  assert.deepEqual(Object.keys(normalized.pages), ['https://example.test/docs'])
  assert.equal(normalized.pages['https://example.test/docs'].url, 'https://example.test/docs')
})

test('mergeSavedPagesWithTabs annotates matching open tabs and emits closed saved page items', () => {
  const savedStore = addSavedPageToStore(
    addSavedPageToStore(emptySavedPagesStore(), makeTab({ url: 'https://example.test/open', title: 'Old open title', favIconUrl: 'old-open.ico' }), 100),
    makeTab({ url: 'https://example.test/closed?panel=reviews#comment-7', title: 'Closed reference', favIconUrl: 'closed.ico' }),
    200
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [
      makeTab({ url: 'https://example.test/open', title: 'Fresh open title', favIconUrl: 'fresh-open.ico' }),
      makeTab({ id: 2, url: 'https://example.test/unsaved', title: 'Unsaved' })
    ],
    savedStore,
    300
  )

  const open = tabs.find((tab) => tab.url === 'https://example.test/open')
  const closed = tabs.find((tab) => tab.url === 'https://example.test/closed?panel=reviews#comment-7')
  assert.equal(open?.sourceType, undefined)
  assert.equal(open?.saved, true)
  assert.equal(open?.closedSaved, false)
  assert.equal(open?.savedPageKey, 'https://example.test/open')
  assert.equal(closed?.sourceType, 'saved-page')
  assert.equal(closed?.saved, true)
  assert.equal(closed?.closedSaved, true)
  assert.equal(closed?.title, 'Closed reference')
  assert.equal(store.pages['https://example.test/open'].title, 'Fresh open title')
  assert.equal(store.pages['https://example.test/open'].favIconUrl, 'fresh-open.ico')
  assert.equal(store.pages['https://example.test/open'].lastSeenOpenAt, 300)
})

test('mergeSavedPagesWithTabs does not rewrite unchanged open saved page metadata', () => {
  const savedStore = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url: 'https://example.test/open', title: 'Open reference', favIconUrl: 'open.ico' }),
    100
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [makeTab({ url: 'https://example.test/open', title: 'Open reference', favIconUrl: 'open.ico' })],
    savedStore,
    300
  )

  assert.equal(tabs[0].saved, true)
  assert.equal(savedPagesStoresEqual(savedStore, store), true)
  assert.equal(store.pages['https://example.test/open'].lastSeenOpenAt, 100)
})
