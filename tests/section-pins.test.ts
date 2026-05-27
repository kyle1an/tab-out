import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SECTION_PIN_STORAGE_KEY,
  loadPinnedSections,
  normalizePinnedSections,
  pathgroupPinId,
  savePinnedSections,
  subdomainPinId,
  togglePinnedSectionInList,
  websitePathPinId
} from '../src/extension/section-pins.js'

// === Identity builders ===

test('subdomainPinId produces a stable kind-prefixed identity', () => {
  assert.equal(subdomainPinId('google.com', 'docs'), 'subdomain|google.com|docs')
  assert.equal(subdomainPinId('example.com', ''), 'subdomain|example.com|')
})

test('websitePathPinId encodes domain, subdomain, and path key', () => {
  assert.equal(
    websitePathPinId('google.com', 'docs', '/document'),
    'website-path|google.com|docs|/document'
  )
  assert.equal(
    websitePathPinId('example.com', '', '/api'),
    'website-path|example.com||/api'
  )
})

test('pathgroupPinId distinguishes subdomain-level vs website-path-level parents', () => {
  // Pathgroup nested inside a website-path section
  assert.equal(
    pathgroupPinId('google.com', 'docs', '/document', '/foo'),
    'pathgroup|google.com|docs|/document|/foo'
  )
  // Pathgroup directly under the subdomain — empty website-path slot keeps the
  // identity layout fixed so two pathgroups with the same label but different
  // parents never collide.
  assert.equal(
    pathgroupPinId('google.com', 'docs', '', '/foo'),
    'pathgroup|google.com|docs||/foo'
  )
})

// === normalizePinnedSections ===

test('normalizePinnedSections returns [] for null/undefined/non-array', () => {
  assert.deepEqual(normalizePinnedSections(undefined), [])
  assert.deepEqual(normalizePinnedSections(null), [])
  assert.deepEqual(normalizePinnedSections('hello'), [])
  assert.deepEqual(normalizePinnedSections(42), [])
})

test('normalizePinnedSections preserves valid ids in input order', () => {
  const input = [
    subdomainPinId('a.com', 'x'),
    websitePathPinId('b.com', '', '/foo'),
    pathgroupPinId('c.com', '', '', '/bar')
  ]
  assert.deepEqual(normalizePinnedSections(input), input)
})

test('normalizePinnedSections dedupes by identity', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(normalizePinnedSections([id, id, id]), [id])
})

test('normalizePinnedSections filters out non-string / empty / unknown-kind entries', () => {
  const valid = subdomainPinId('a.com', 'x')
  const input = [valid, '', null, undefined, 42, 'plainstring', 'bad|kind|x']
  assert.deepEqual(normalizePinnedSections(input), [valid])
})

// === togglePinnedSectionInList ===

test('togglePinnedSectionInList adds an absent id', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(togglePinnedSectionInList([], id), [id])
})

test('togglePinnedSectionInList removes a present id', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(togglePinnedSectionInList([id], id), [])
})

test('togglePinnedSectionInList ignores invalid identities', () => {
  const valid = subdomainPinId('a.com', 'x')
  assert.deepEqual(togglePinnedSectionInList([valid], 'bogus'), [valid])
  assert.deepEqual(togglePinnedSectionInList([valid], ''), [valid])
})

test('togglePinnedSectionInList normalizes the existing list before toggling', () => {
  const a = subdomainPinId('a.com', 'x')
  const b = subdomainPinId('b.com', '')
  assert.deepEqual(togglePinnedSectionInList([a, a, 'bogus', undefined], b), [a, b])
})

// === load/save (chrome.storage.local shim) ===

type ChromeShim = {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>
      set: (values: Record<string, unknown>) => Promise<void>
    }
  }
}

function installChromeStorageMock(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  const mock: ChromeShim = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (values) => { Object.assign(store, values) }
      }
    }
  }
  const previous = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome?: unknown }).chrome = mock
  return () => {
    if (previous === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previous
  }
}

test('loadPinnedSections returns [] when chrome.storage is unavailable', async () => {
  const previous = (globalThis as { chrome?: unknown }).chrome
  delete (globalThis as { chrome?: unknown }).chrome
  try {
    assert.deepEqual(await loadPinnedSections(), [])
  } finally {
    if (previous !== undefined) (globalThis as { chrome?: unknown }).chrome = previous
  }
})

test('loadPinnedSections reads and normalizes the stored value', async () => {
  const id = subdomainPinId('a.com', 'x')
  const restore = installChromeStorageMock({
    [SECTION_PIN_STORAGE_KEY]: [id, 'bogus', id]
  })
  try {
    assert.deepEqual(await loadPinnedSections(), [id])
  } finally {
    restore()
  }
})

test('savePinnedSections writes a normalized value', async () => {
  const restore = installChromeStorageMock()
  try {
    const a = subdomainPinId('a.com', 'x')
    await savePinnedSections([a, a, 'bogus'])
    assert.deepEqual(await loadPinnedSections(), [a])
  } finally {
    restore()
  }
})
