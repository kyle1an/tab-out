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

function chipFor(tabs: DashboardTab[], url: string): DashboardChipData | undefined {
  const group: DomainGroup = { domain: 'example.com', tabs }
  const vm = computeDomainCardViewModel(group, { currentWindowId: 1, allowMutations: false })
  return collectChips(vm).find((c) => c.tabUrl === url)
}

test('chip audioState is playing for an audible unmuted tab', () => {
  const chip = chipFor([makeTab({ url: 'https://example.com/a', audible: true })], 'https://example.com/a')
  assert.equal(chip?.audioState, 'playing')
})

test('chip audioState is muted for a muted tab', () => {
  const chip = chipFor([makeTab({ url: 'https://example.com/b', audible: true, muted: true })], 'https://example.com/b')
  assert.equal(chip?.audioState, 'muted')
})

test('chip audioState is null for a silent tab', () => {
  const chip = chipFor([makeTab({ url: 'https://example.com/c' })], 'https://example.com/c')
  assert.equal(chip?.audioState, null)
})
