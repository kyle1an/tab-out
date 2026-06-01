import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import { buildDomainGroups } from '../src/extension/render.js'
import {
  createPinnedPageChipIndex,
  pageChipPinId,
  pageChipPinKeyForUrl,
  pageChipPinScopeId
} from '../src/extension/page-chip-pins.js'
import type { DashboardTab } from '../src/extension/types'

;(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    getURL(path: string) {
      return `chrome-extension://tab-out${path}`
    }
  }
}
;(globalThis as { window?: unknown }).window = {
  LOCAL_PATH_GROUPERS: [],
  LOCAL_CUSTOM_GROUPS: []
}

function makeTab(overrides: Partial<DashboardTab> & { url: string; id: number; title: string }): DashboardTab {
  return {
    id: overrides.id,
    url: overrides.url,
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: overrides.title,
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: overrides.isApp || false,
    index: overrides.index,
    sourceType: overrides.sourceType,
    saved: overrides.saved,
    savedPageKey: overrides.savedPageKey,
    ...overrides
  }
}

function groupFor(domain: string, tabs: DashboardTab[]) {
  const group = buildDomainGroups(tabs).find((g) => g.domain === domain)
  assert.ok(group, `expected a domain group for ${domain}`)
  return group
}

test('computeDomainCardViewModel sorts pinned page chips first only inside their rendered flat scope', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Alpha', url: 'https://example.com/alpha' }),
    makeTab({ id: 2, title: 'Bravo', url: 'https://example.com/bravo' }),
    makeTab({ id: 3, title: 'Charlie', url: 'https://example.com/charlie' }),
    makeTab({ id: 4, title: 'Docs Alpha', url: 'https://example.com/docs/alpha' }),
    makeTab({ id: 5, title: 'Docs Bravo', url: 'https://example.com/docs/bravo' })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const docsScope = pageChipPinScopeId('example.com', '', '/docs', '')
  const pinnedPageChips = createPinnedPageChipIndex([
    pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/charlie')),
    pageChipPinId('tabs', docsScope, pageChipPinKeyForUrl('https://example.com/docs/bravo'))
  ])

  const baseline = computeDomainCardViewModel(group, { source: 'tabs' })
  const baselineSection = baseline.sections?.find((section) => section.key === '')
  assert.ok(baselineSection)
  assert.deepEqual(
    baselineSection.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/alpha', 'https://example.com/bravo', 'https://example.com/charlie']
  )
  assert.deepEqual(
    baselineSection.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/docs/alpha', 'https://example.com/docs/bravo']
  )

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((section) => section.key === '')
  assert.ok(section)
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/charlie', 'https://example.com/alpha', 'https://example.com/bravo']
  )
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false, false]
  )
  assert.deepEqual(
    section.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/docs/bravo', 'https://example.com/docs/alpha']
  )
  assert.deepEqual(
    section.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false]
  )
})

test('computeDomainCardViewModel sorts pinned folded chips as aggregate rows', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Alpha Env', url: 'https://dev.example.com/alpha' }),
    makeTab({ id: 2, title: 'Alpha Env', url: 'https://qa.example.com/alpha' }),
    makeTab({ id: 3, title: 'Bravo Env', url: 'https://dev.example.com/bravo' }),
    makeTab({ id: 4, title: 'Bravo Env', url: 'https://qa.example.com/bravo' })
  ]
  const group = groupFor('example.com', tabs)
  const sharedScope = pageChipPinScopeId('example.com', '__shared__', '', '')
  const pinnedPageChips = createPinnedPageChipIndex([
    pageChipPinId('tabs', sharedScope, `fold:${['https://dev.example.com/bravo', 'https://qa.example.com/bravo'].sort().join('\u0000')}`)
  ])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const sharedSection = vm.sections?.find((section) => section.key === '__shared__')
  assert.ok(sharedSection)
  assert.deepEqual(
    sharedSection.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://dev.example.com/bravo', 'https://dev.example.com/alpha']
  )
  assert.deepEqual(
    sharedSection.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false]
  )
})

test('computeDomainCardViewModel promotes pinned same-title URL variants into their parent chip scope', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Example content item', url: 'https://example.com/alpha' }),
    makeTab({ id: 2, title: 'Example content item', url: 'https://example.com/bravo' }),
    makeTab({ id: 3, title: 'Example content item', url: 'https://example.com/charlie' }),
    makeTab({ id: 4, title: 'Settings', url: 'https://example.com/settings' })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const alphaPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/alpha'))
  const bravoPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/bravo'))
  const charliePinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/charlie'))
  const pinnedPageChips = createPinnedPageChipIndex([bravoPinId])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((candidate) => candidate.key === '')
  assert.ok(section)
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.tabUrl),
    [
      'https://example.com/bravo',
      'https://example.com/alpha',
      'https://example.com/settings'
    ]
  )

  const [pinnedVariant, remainingGroup] = section.flatVisibleChips
  assert.equal(pinnedVariant.pagePinId, bravoPinId)
  assert.equal(pinnedVariant.pagePinned, true)
  assert.equal(remainingGroup.pagePinId, undefined)
  assert.equal(remainingGroup.pagePinned, undefined)
  assert.deepEqual(
    remainingGroup.titleVariantChips?.map((variant) => variant.tabUrl),
    [
      'https://example.com/alpha',
      'https://example.com/charlie'
    ]
  )
  assert.deepEqual(
    remainingGroup.titleVariantChips?.map((variant) => variant.pagePinId),
    [alphaPinId, charliePinId]
  )
  assert.deepEqual(
    remainingGroup.titleVariantChips?.map((variant) => variant.pagePinned),
    [false, false]
  )
})
