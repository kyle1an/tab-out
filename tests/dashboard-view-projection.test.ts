import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { domainCardId } from '../src/extension/domain-card-id.js'
import type { MissionOrderMap } from '../src/extension/dashboard-intake.js'
import { buildDomainGroups, dashboardChipOrderKeyForTab } from '../src/extension/render.js'
import type { DashboardData, DashboardSource, DashboardTab } from '../src/extension/types'
import { rememberMissionOrder, useDashboardViewModels, type DashboardChipOrderMemoryMap } from '../src/hooks/useDashboardViewModels.js'

function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected rendered hook value')
  return value
}

function renderHookValue<T>(run: () => T): T {
  let value: T | undefined
  renderToStaticMarkup(React.createElement(() => {
    value = run()
    return null
  }))
  return expectDefined(value)
}

function makeTab(input: Pick<DashboardTab, 'id' | 'url' | 'title'> & Partial<DashboardTab>): DashboardTab {
  return {
    rawUrl: input.url,
    suspended: false,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...input,
  }
}

function renderView(dashboard: DashboardData, view: 'open-saved' | 'all-tabs', filter = '') {
  return renderHookValue(() => useDashboardViewModels({
    dashboard,
    source: 'tabs',
    view,
    filter,
    historyRange: '1d',
    historyFilterEnabled: false,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map(),
    },
  }))
}

test('Open + Saved projects retained-only pages out without changing the complete dashboard', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://open.example.test/', title: 'Open page' }),
    makeTab({
      id: 'saved',
      url: 'https://saved.example.test/',
      title: 'Saved page',
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true,
    }),
    makeTab({
      id: 'retained',
      url: 'https://retained.example.test/',
      title: 'Retained page',
      sourceType: 'retained-page',
      closedSaved: true,
      retainedPageIdentity: 'retained-identity',
      retainedPageClosureToken: 'retained-lifetime',
    }),
  ]
  const dashboard: DashboardData = {
    realTabs: tabs,
    domainGroups: buildDomainGroups(tabs),
  }

  const openSaved = renderView(dashboard, 'open-saved')
  assert.deepEqual(
    openSaved.matchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.sourceType ?? 'tab')),
    ['tab', 'saved-page'],
  )
  assert.equal(openSaved.retainedPagesAvailable, true)
  assert.equal(openSaved.hiddenRetainedFilterMatch, false)

  const allTabs = renderView(dashboard, 'all-tabs')
  assert.deepEqual(
    allTabs.matchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.sourceType ?? 'tab')),
    ['tab', 'saved-page', 'retained-page'],
  )
  assert.equal(allTabs.retainedPagesAvailable, false)
  assert.equal(allTabs.hiddenRetainedFilterMatch, false)
  assert.equal(dashboard.realTabs, tabs)
  assert.equal(dashboard.domainGroups.flatMap((group) => group.tabs).length, 3)
})

test('Open + Saved excludes retained-only pages before companion-result dedupe', () => {
  const retainedTab = makeTab({
    id: 'retained',
    url: 'https://retained.example.test/reference',
    title: 'Retained reference',
    sourceType: 'retained-page',
    closedSaved: true,
    retainedPageIdentity: 'retained-identity',
    retainedPageClosureToken: 'retained-lifetime',
  })
  const bookmarkTab = makeTab({
    id: 'bookmark',
    url: retainedTab.url,
    title: 'Retained reference bookmark',
    sourceType: 'bookmark',
  })
  const dashboard: DashboardData = {
    realTabs: [retainedTab],
    domainGroups: buildDomainGroups([retainedTab]),
    bookmarkTabs: [bookmarkTab],
    bookmarkDomainGroups: buildDomainGroups([bookmarkTab]),
    bookmarkSearchReady: true,
  }

  const openSaved = renderView(dashboard, 'open-saved', 'retained')
  assert.equal(openSaved.matchedCards.length, 0)
  assert.equal(openSaved.hiddenRetainedFilterMatch, true)
  assert.deepEqual(
    openSaved.bookmarkMatchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.url)),
    [retainedTab.url],
  )

  const allTabs = renderView(dashboard, 'all-tabs', 'retained')
  assert.deepEqual(
    allTabs.matchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.url)),
    [retainedTab.url],
  )
  assert.equal(allTabs.bookmarkMatchedCards.length, 0)
})

test('Open + Saved retains hidden Tabs order memory until All Tabs replaces it', () => {
  const openTab = makeTab({
    id: 1,
    url: 'https://mixed.test/open',
    title: 'Open page',
  })
  const retainedChip = makeTab({
    id: 'retained-chip',
    url: 'https://mixed.test/closed',
    title: 'Retained chip',
    sourceType: 'retained-page',
    closedSaved: true,
  })
  const retainedCard = makeTab({
    id: 'retained-card',
    url: 'https://closed-only.test/page',
    title: 'Retained card',
    sourceType: 'retained-page',
    closedSaved: true,
  })
  const tabs = [openTab, retainedChip, retainedCard]
  const dashboard: DashboardData = {
    realTabs: tabs,
    domainGroups: buildDomainGroups(tabs),
  }
  const previousOrder: MissionOrderMap = {
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map(),
  }
  const chipOrder: DashboardChipOrderMemoryMap = {
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map(),
  }
  const tabsSource: DashboardSource = 'tabs'
  const sharedMemoryOptions = {
    previousOrder,
    chipOrder,
    source: tabsSource,
    filter: '',
    bookmarkMatchedCards: [],
    historyMatchedCards: [],
  }
  const retainedCardId = domainCardId('closed-only.test')
  const mixedCardId = domainCardId('mixed.test')
  const retainedChipKey = dashboardChipOrderKeyForTab(retainedChip)

  rememberMissionOrder({
    ...sharedMemoryOptions,
    view: 'all-tabs',
    matchedCards: renderView(dashboard, 'all-tabs').matchedCards,
  })
  assert.equal(previousOrder.tabs.has(retainedCardId), true)
  assert.equal(chipOrder.tabs.get(mixedCardId)?.has(retainedChipKey), true)

  rememberMissionOrder({
    ...sharedMemoryOptions,
    view: 'open-saved',
    matchedCards: renderView(dashboard, 'open-saved').matchedCards,
  })
  assert.equal(previousOrder.tabs.has(retainedCardId), true)
  assert.equal(chipOrder.tabs.get(mixedCardId)?.has(retainedChipKey), true)

  const openOnlyDashboard: DashboardData = {
    realTabs: [openTab],
    domainGroups: buildDomainGroups([openTab]),
  }
  rememberMissionOrder({
    ...sharedMemoryOptions,
    view: 'all-tabs',
    matchedCards: renderView(openOnlyDashboard, 'all-tabs').matchedCards,
  })
  assert.equal(previousOrder.tabs.has(retainedCardId), false)
  assert.equal(chipOrder.tabs.get(mixedCardId)?.has(retainedChipKey), false)
})
