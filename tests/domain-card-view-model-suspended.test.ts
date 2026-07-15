import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import type { DashboardCardVM, DashboardChipData, DashboardTab, DomainGroup } from '../src/extension/types'

function makeTab(o: Partial<DashboardTab> & { url: string }): DashboardTab {
  return {
    url: o.url,
    rawUrl: o.url,
    suspended: false,
    title: o.title ?? o.url,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...o
  }
}

function collectChips(vm: DashboardCardVM): DashboardChipData[] {
  const chips: DashboardChipData[] = []
  for (const section of vm.sections ?? []) {
    chips.push(...section.flatVisibleChips, ...section.flatHiddenChips)
    for (const cluster of section.clusters) chips.push(...cluster.visibleChips, ...cluster.hiddenChips)
    for (const ws of section.websitePathSections) {
      chips.push(...ws.flatVisibleChips, ...ws.flatHiddenChips)
      for (const cluster of ws.clusters) chips.push(...cluster.visibleChips, ...cluster.hiddenChips)
    }
  }
  return chips
}

function chipFor(tabs: DashboardTab[], url: string, domain = 'example.com'): DashboardChipData | undefined {
  const group: DomainGroup = { domain, tabs }
  const vm = computeDomainCardViewModel(group, { currentWindowId: 1, allowMutations: false })
  return collectChips(vm).find((c) => c.tabUrl === url)
}

test('a live tab chip is not suspended', () => {
  const chip = chipFor([makeTab({ id: 1, url: 'https://example.com/a' })], 'https://example.com/a')
  assert.ok(chip)
  assert.ok(!chip.suspended)
})

test('a suspended tab chip is suspended', () => {
  const chip = chipFor([makeTab({ id: 1, url: 'https://example.com/a', suspended: true })], 'https://example.com/a')
  assert.ok(chip)
  assert.equal(chip.suspended, true)
})

test('a dupe stack with one live copy is not suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://example.com/a', suspended: true }),
      makeTab({ id: 2, url: 'https://example.com/a', windowId: 2 })
    ],
    'https://example.com/a'
  )
  assert.ok(chip)
  assert.equal(chip.dupeCount, 2)
  assert.ok(!chip.suspended)
})

test('a dupe stack of only suspended copies is suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://example.com/a', suspended: true }),
      makeTab({ id: 2, url: 'https://example.com/a', windowId: 2, suspended: true })
    ],
    'https://example.com/a'
  )
  assert.ok(chip)
  assert.equal(chip.dupeCount, 2)
  assert.equal(chip.suspended, true)
})

test('a closed saved page chip is not suspended', () => {
  const chip = chipFor(
    [makeTab({ id: 'saved:1', url: 'https://example.com/a', windowId: 0, sourceType: 'saved-page', saved: true, closedSaved: true })],
    'https://example.com/a'
  )
  assert.ok(chip)
  assert.ok(!chip.suspended)
})

test('a title-variant group with a live variant is not suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://example.com/a', title: 'Same Title', suspended: true }),
      makeTab({ id: 2, url: 'https://example.com/b', title: 'Same Title' })
    ],
    'https://example.com/a'
  )
  assert.ok(chip)
  assert.equal(chip.titleVariantChips?.length, 2)
  assert.ok(!chip.suspended)
})

test('a title-variant group of suspended variants is suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://example.com/a', title: 'Same Title', suspended: true }),
      makeTab({ id: 2, url: 'https://example.com/b', title: 'Same Title', suspended: true })
    ],
    'https://example.com/a'
  )
  assert.ok(chip)
  assert.equal(chip.titleVariantChips?.length, 2)
  assert.equal(chip.suspended, true)
})

test('a folded env chip with a live env is not suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://dev.example.com/app', suspended: true }),
      makeTab({ id: 2, url: 'https://qa.example.com/app' })
    ],
    'https://dev.example.com/app'
  )
  assert.ok(chip)
  assert.equal(chip.envs?.length, 2)
  assert.ok(!chip.suspended)
})

test('a folded env chip of suspended envs is suspended', () => {
  const chip = chipFor(
    [
      makeTab({ id: 1, url: 'https://dev.example.com/app', suspended: true }),
      makeTab({ id: 2, url: 'https://qa.example.com/app', suspended: true })
    ],
    'https://dev.example.com/app'
  )
  assert.ok(chip)
  assert.equal(chip.envs?.length, 2)
  assert.equal(chip.suspended, true)
})
