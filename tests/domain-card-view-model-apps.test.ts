import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import type { DashboardTab, DomainGroup } from '../src/extension/types'

function makeAppTab(o: Partial<DashboardTab> & { url: string, title: string }): DashboardTab {
  return {
    rawUrl: o.url,
    suspended: false,
    favIconUrl: '',
    windowId: 9,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: true,
    ...o,
  }
}

test('apps card chips carry their titles instead of rendering icon-only', () => {
  const group: DomainGroup = {
    domain: '__standalone-apps__',
    label: 'Apps',
    tabs: [
      makeAppTab({ id: 1, url: 'https://mail.example.com/inbox', title: 'Inbox - Mail' }),
      makeAppTab({ id: 2, url: 'https://calendar.example.com/week', title: 'Week View - Calendar' }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1, allowMutations: false })
  const [section] = vm.sections ?? []
  assert.ok(section)
  const chips = section.flatVisibleChips

  assert.equal(chips.length, 2)
  for (const chip of chips) {
    assert.ok(!chip.iconOnly, `chip for ${chip.tabUrl} should not be icon-only`)
    assert.equal(chip.isApp, true)
  }
  assert.deepEqual(chips.map((chip) => chip.title), ['Inbox - Mail', 'Week View - Calendar'])
})

test('apps card chips keep raw titles like history rows — no noise cleanup, no suppression', () => {
  const rawTitle = 'Inbox (414) - person@example.com - Example Mail'
  const group: DomainGroup = {
    domain: '__standalone-apps__',
    label: 'Apps',
    tabs: [makeAppTab({ id: 1, url: 'https://mail.example.com/inbox', title: rawTitle })],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1, allowMutations: false })
  const [section] = vm.sections ?? []
  assert.ok(section)
  const [chip] = section.flatVisibleChips

  assert.ok(chip)
  assert.equal(chip.title, rawTitle)
  assert.deepEqual(chip.suppressedTitleParts, [])
})
