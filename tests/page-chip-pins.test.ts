import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPinnedPageChipMutation,
  createPinnedPageChipIndex,
  normalizePinnedPageChips,
  pageChipPinId,
  pageChipPinKeyForUrl,
  pageChipPinScopeId,
  pinnedPageChipOrder
} from '../src/extension/page-chip-pins.js'

test('pageChipPinId produces a source-scoped encoded page chip identity', () => {
  const scopeId = pageChipPinScopeId('example.com', 'docs', '/guide', 'alpha/repo')
  const chipKey = pageChipPinKeyForUrl('https://docs.example.com/guide/a?x=1|2')

  assert.equal(
    pageChipPinId('tabs', scopeId, chipKey),
    'page-chip|tabs|scope%7Cexample.com%7Cdocs%7C%2Fguide%7Calpha%2Frepo|url%3Ahttps%3A%2F%2Fdocs.example.com%2Fguide%2Fa%3Fx%3D1%7C2'
  )
})

test('normalizePinnedPageChips preserves valid ids in pin order and dedupes by identity', () => {
  const scopeId = pageChipPinScopeId('example.com', '', '', '')
  const first = pageChipPinId('tabs', scopeId, pageChipPinKeyForUrl('https://example.com/a'))
  const second = pageChipPinId('tabs', scopeId, pageChipPinKeyForUrl('https://example.com/b'))

  assert.deepEqual(
    normalizePinnedPageChips([first, 'bogus', first, '', null, second]),
    [first, second]
  )
})

test('applyPinnedPageChipMutation removes an existing pin and appends a new pin', () => {
  const scopeId = pageChipPinScopeId('example.com', '', '', '')
  const first = pageChipPinId('tabs', scopeId, pageChipPinKeyForUrl('https://example.com/a'))
  const second = pageChipPinId('tabs', scopeId, pageChipPinKeyForUrl('https://example.com/b'))

  assert.deepEqual(applyPinnedPageChipMutation([first], { type: 'set-pinned', id: first, pinned: false }), [])
  assert.deepEqual(applyPinnedPageChipMutation([first], { type: 'set-pinned', id: second, pinned: true }), [first, second])
})

test('createPinnedPageChipIndex exposes per-source and per-scope pin order', () => {
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const docsScope = pageChipPinScopeId('example.com', '', '/docs', '')
  const first = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/a'))
  const second = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/b'))
  const otherScope = pageChipPinId('tabs', docsScope, pageChipPinKeyForUrl('https://example.com/docs/a'))
  const otherSource = pageChipPinId('bookmarks', rootScope, pageChipPinKeyForUrl('https://example.com/a'))
  const index = createPinnedPageChipIndex([first, second, otherScope, otherSource])

  assert.equal(pinnedPageChipOrder(index, 'tabs', rootScope, pageChipPinKeyForUrl('https://example.com/a')), 0)
  assert.equal(pinnedPageChipOrder(index, 'tabs', rootScope, pageChipPinKeyForUrl('https://example.com/b')), 1)
  assert.equal(pinnedPageChipOrder(index, 'tabs', docsScope, pageChipPinKeyForUrl('https://example.com/docs/a')), 2)
  assert.equal(pinnedPageChipOrder(index, 'bookmarks', rootScope, pageChipPinKeyForUrl('https://example.com/a')), 3)
  assert.equal(pinnedPageChipOrder(index, 'tabs', rootScope, pageChipPinKeyForUrl('https://example.com/c')), null)
})
