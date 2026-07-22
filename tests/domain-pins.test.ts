import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOMAIN_PIN_STORAGE_KEY,
  loadPinnedDomainsResult,
  movePinnedDomainInList,
  normalizePinnedDomains,
  reorderPinnedDomainInList,
  togglePinnedDomainInList
} from '../src/extension/domain-pins.js'

test('normalizePinnedDomains preserves order, removes invalid entries, and allows pinnable utility cards', () => {
  assert.deepEqual(
    normalizePinnedDomains(['example.com', '__private__', 'example.com', '__tab-out__', null, '__standalone-apps__']),
    ['example.com', '__tab-out__', '__standalone-apps__']
  )
})

test('togglePinnedDomainInList removes existing domains and appends new domains', () => {
  assert.deepEqual(togglePinnedDomainInList(['example.com', 'docs.example'], 'example.com'), ['docs.example'])
  assert.deepEqual(togglePinnedDomainInList(['example.com'], 'docs.example'), ['example.com', 'docs.example'])
})

test('reorderPinnedDomainInList moves a pinned domain before or after another pinned domain', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test', 'delta.test']

  assert.deepEqual(
    reorderPinnedDomainInList(domains, 'delta.test', 'bravo.test', 'before'),
    ['alpha.test', 'delta.test', 'bravo.test', 'charlie.test']
  )
  assert.deepEqual(
    reorderPinnedDomainInList(domains, 'alpha.test', 'charlie.test', 'after'),
    ['bravo.test', 'charlie.test', 'alpha.test', 'delta.test']
  )
})

test('reorderPinnedDomainInList ignores unknown, invalid, and same-domain targets', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(reorderPinnedDomainInList(domains, 'missing.test', 'bravo.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'missing.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'alpha.test', 'after'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, '__private__', 'bravo.test', 'before'), domains)
})

test('reorderPinnedDomainInList preserves order for adjacent equivalent placements', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'bravo.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'bravo.test', 'alpha.test', 'after'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'bravo.test', 'charlie.test', 'before'), domains)
})

test('movePinnedDomainInList moves adjacent to the previous or next pinned domain', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'previous'), ['bravo.test', 'alpha.test', 'charlie.test'])
  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'next'), ['alpha.test', 'charlie.test', 'bravo.test'])
})

test('movePinnedDomainInList ignores edge and unknown domains', () => {
  const domains = ['alpha.test', 'bravo.test']

  assert.deepEqual(movePinnedDomainInList(domains, 'alpha.test', 'previous'), domains)
  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'next'), domains)
  assert.deepEqual(movePinnedDomainInList(domains, 'missing.test', 'next'), domains)
})

test('loadPinnedDomainsResult rejects malformed stored state', async () => {
  const previous = globalThis.chrome
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ [DOMAIN_PIN_STORAGE_KEY]: {} })
      }
    }
  } as unknown as typeof globalThis.chrome

  try {
    assert.deepEqual(await loadPinnedDomainsResult(), { ok: false, value: [] })
  } finally {
    globalThis.chrome = previous
  }
})
