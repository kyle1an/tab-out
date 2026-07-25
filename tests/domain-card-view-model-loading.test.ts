import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import type { DashboardTab, DomainGroup } from '../src/extension/types'

function makeTab(overrides: Partial<DashboardTab> = {}): DashboardTab {
  return {
    id: 1,
    url: 'https://example.test/page',
    rawUrl: 'https://example.test/page',
    suspended: false,
    title: 'Example Page',
    status: 'complete',
    favIconUrl: 'https://example.test/favicon.png',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    sourceType: 'tab',
    ...overrides
  }
}

function firstChip(tabs: DashboardTab[]) {
  const group: DomainGroup = { domain: 'example.test', tabs }
  return computeDomainCardViewModel(group, { currentWindowId: 1 }).sections?.[0]?.flatVisibleChips[0]
}

test('a loading live tab produces a loading Page Chip', () => {
  const chip = firstChip([makeTab({ status: 'loading' })])

  assert.equal(chip?.loading, true)
})

test('a same-title Page Chip loads when any URL variant is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1, url: 'https://example.test/alpha', rawUrl: 'https://example.test/alpha', title: 'Shared title' }),
    makeTab({ id: 2, url: 'https://example.test/beta', rawUrl: 'https://example.test/beta', title: 'Shared title', status: 'loading' })
  ])

  assert.equal(chip?.titleVariantChips?.length, 2)
  assert.equal(chip?.loading, true)
})

test('a folded Page Chip loads when any environment is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1, url: 'https://dev.example.test/app', rawUrl: 'https://dev.example.test/app' }),
    makeTab({ id: 2, url: 'https://qa.example.test/app', rawUrl: 'https://qa.example.test/app', status: 'loading' })
  ])

  assert.equal(chip?.envs?.length, 2)
  assert.equal(chip?.loading, true)
})

test('a duplicate Page Chip loads when any open copy is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1 }),
    makeTab({ id: 2, windowId: 2, status: 'loading' })
  ])

  assert.equal(chip?.dupeCount, 2)
  assert.equal(chip?.loading, true)
})

test('only awake open tabs can make a Page Chip loading', () => {
  const complete = firstChip([makeTab()])
  const unloaded = firstChip([makeTab({ status: 'unloaded' })])
  const suspended = firstChip([makeTab({ suspended: true, status: 'loading' })])
  const bookmark = firstChip([makeTab({ id: 'bookmark:1', sourceType: 'bookmark', status: 'loading' })])
  const history = firstChip([makeTab({ id: 'history:1', sourceType: 'history', status: 'loading' })])
  const closedSaved = firstChip([makeTab({ id: 'saved:1', sourceType: 'saved-page', saved: true, closedSaved: true, status: 'loading' })])

  assert.deepEqual(
    [complete, unloaded, suspended, bookmark, history, closedSaved].map((chip) => chip?.loading),
    [false, false, false, false, false, false]
  )
})
