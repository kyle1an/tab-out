import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import { titleVariantTargets } from '../src/extension/url-variant-presentation.js'
import type { DomainGroup } from '../src/extension/types'
import { collectDashboardChips, makeDashboardTab } from './helpers/domain-card-view-model.js'

test('two Jira URL forms of the same comment collapse into one closable duplicate', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [makeDashboardTab({ id: 1, url: longForm }), makeDashboardTab({ id: 2, url: shortForm })],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls, ['https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'])

  const jiraChips = collectDashboardChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 1)
})

test('different focused comments on the same issue are not treated as duplicates', () => {
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({ id: 1, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100' }),
      makeDashboardTab({ id: 2, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200' }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls ?? [], [])
  const jiraChips = collectDashboardChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 2)
})

test('multiple exact Saved targets sharing one canonical identity remain independently actionable', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const shortForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({
        id: 'saved-long',
        url: longForm,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: longForm,
      }),
      makeDashboardTab({
        id: 'saved-short',
        url: shortForm,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: shortForm,
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group)
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)
  const variants = titleVariantTargets(chip.titleVariantPresentations)
  assert.equal(variants.length, 2)

  assert.equal(vm.tabCountLabel, '2 closed')
  assert.equal(chip.dupeCount, 1)
  assert.deepEqual(
    variants.map((variant) => ({
      savedPageKey: variant.savedPageKey,
      url: variant.tabUrl,
    })).toSorted((left, right) => left.url.localeCompare(right.url)),
    [
      { savedPageKey: longForm, url: longForm },
      { savedPageKey: shortForm, url: shortForm },
    ].toSorted((left, right) => left.url.localeCompare(right.url)),
  )
})

test('same-title presentations keep repeated exact URL targets independently owned', () => {
  const repeatedUrl = 'https://example.test/content?state=alpha'
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: repeatedUrl,
        title: 'Shared title',
      }),
      makeDashboardTab({
        id: 'retained-alpha',
        url: repeatedUrl,
        title: 'Shared title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-alpha',
        retainedPageClosureToken: 'lifetime-alpha',
      }),
      makeDashboardTab({
        id: 2,
        url: 'https://example.test/content?state=bravo',
        title: 'Shared title',
      }),
    ],
  }

  const [chip] = collectDashboardChips(computeDomainCardViewModel(group))
  assert.ok(chip)
  const presentations = chip.titleVariantPresentations ?? []
  const repeatedPresentations = presentations.filter(({ targets }) => targets[0]?.tabUrl === repeatedUrl)

  assert.equal(presentations.length, 3)
  assert.equal(titleVariantTargets(presentations).length, 3)
  assert.equal(repeatedPresentations.length, 2)
  assert.ok(repeatedPresentations.every(({ targets }) => targets.length === 1))
  assert.deepEqual(
    repeatedPresentations.map(({ targets }) => targets[0]?.sourceType).toSorted(),
    ['retained-page', 'tab'],
  )
})

test('a closed Saved target does not inherit live state from a canonical-equivalent open tab', () => {
  const openUrl =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const savedUrl =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: openUrl,
        title: 'Example issue',
        windowId: 2,
        active: true,
        suspended: true,
        status: 'loading',
        audible: true,
      }),
      makeDashboardTab({
        id: 'saved-exact',
        url: savedUrl,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: savedUrl,
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const [groupedChip] = collectDashboardChips(vm)
  const savedVariant = titleVariantTargets(groupedChip?.titleVariantPresentations).find(
    (variant) => variant.savedPageKey === savedUrl,
  )
  assert.ok(savedVariant)

  assert.equal(vm.tabCountLabel, '1 + 1 closed')
  assert.equal(savedVariant.dupeCount, 1)
  assert.equal(savedVariant.suspended, false)
  assert.equal(savedVariant.loading, false)
  assert.equal(savedVariant.activeChipFrame, false)
  assert.equal(savedVariant.activeInOtherWindow, false)
  assert.equal(savedVariant.audioState, null)
})

test('a retained row is one unique closed item without a duplicate count', () => {
  const url = 'https://example.test/article'
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 'retained-example',
        url,
        title: 'Example article',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-example',
        retainedPageClosureToken: 'lifetime-example',
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group)
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)

  assert.equal(vm.tabCountLabel, '1 closed')
  assert.equal(vm.tabCountTitle, '0 open tabs, 1 closed page')
  assert.deepEqual(vm.closableDupeUrls, [])
  assert.equal(vm.closableExtras, 0)
  assert.equal(chip.sourceType, 'retained-page')
  assert.equal(chip.dupeCount, 1)
  assert.equal(chip.titleVariantPresentations, undefined)
})

test('card removal targets include only exact retained snapshots in the matched scope', () => {
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: 'https://example.test/live',
        title: 'Live page',
      }),
      makeDashboardTab({
        id: 2,
        url: 'https://example.test/grouped',
        title: 'Grouped live page',
        groupId: 42,
      }),
      makeDashboardTab({
        id: 'saved-page',
        url: 'https://example.test/saved',
        title: 'Saved page',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: 'https://example.test/saved',
      }),
      makeDashboardTab({
        id: 'retained-alpha',
        url: 'https://example.test/alpha',
        title: 'Shared retained title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-alpha',
        retainedPageClosureToken: 'lifetime-alpha',
      }),
      makeDashboardTab({
        id: 'retained-bravo',
        url: 'https://example.test/bravo',
        title: 'Shared retained title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-bravo',
        retainedPageClosureToken: 'lifetime-bravo',
      }),
    ],
  }

  const unfiltered = computeDomainCardViewModel(group)
  assert.deepEqual(unfiltered.retainedPageRemovalTargets, [
    {
      retainedPageIdentity: 'identity-alpha',
      retainedPageClosureToken: 'lifetime-alpha',
    },
    {
      retainedPageIdentity: 'identity-bravo',
      retainedPageClosureToken: 'lifetime-bravo',
    },
  ])
  assert.equal(unfiltered.retainedPageRemovalLabel, 'Remove 2 from Tabs')
  assert.equal(unfiltered.closableCount, 1)
  const retainedVariantIdentities = collectDashboardChips(unfiltered)
    .flatMap((chip) => {
      const variants = titleVariantTargets(chip.titleVariantPresentations)
      return variants.length > 0 ? variants : [chip]
    })
    .flatMap((chip) => chip.retainedPageIdentity ?? [])
    .toSorted()
  assert.deepEqual(retainedVariantIdentities, ['identity-alpha', 'identity-bravo'])

  const filtered = computeDomainCardViewModel(group, { filter: 'alpha' })
  assert.deepEqual(filtered.retainedPageRemovalTargets, [{
    retainedPageIdentity: 'identity-alpha',
    retainedPageClosureToken: 'lifetime-alpha',
  }])
  assert.equal(filtered.retainedPageRemovalLabel, 'Remove from Tabs')

  const readOnly = computeDomainCardViewModel(group, { allowMutations: false })
  assert.deepEqual(readOnly.retainedPageRemovalTargets, [])
})

test('the Apps card exposes exact retained app snapshots for batch removal', () => {
  const group: DomainGroup = {
    domain: '__standalone-apps__',
    label: 'Apps',
    tabs: [makeDashboardTab({
      id: 'retained-app',
      url: 'https://app.example.test/document',
      title: 'Retained App Document',
      sourceType: 'retained-page',
      closedSaved: true,
      retainedPageIdentity: 'identity-app',
      retainedPageClosureToken: 'lifetime-app',
      isApp: true,
    })],
  }

  const vm = computeDomainCardViewModel(group)

  assert.deepEqual(vm.retainedPageRemovalTargets, [{
    retainedPageIdentity: 'identity-app',
    retainedPageClosureToken: 'lifetime-app',
  }])
  assert.equal(vm.retainedPageRemovalLabel, 'Remove from Tabs')
  assert.equal(vm.closableCount, 0)
})

test('GitHub repository root slash variants collapse into one closable duplicate', () => {
  const repository = 'https://github.com/example/repo'
  const group: DomainGroup = {
    domain: 'github.com',
    tabs: [
      makeDashboardTab({ id: 1, url: repository, title: 'example/repo' }),
      makeDashboardTab({ id: 2, url: `${repository}/`, title: 'example/repo' }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)

  assert.deepEqual(vm.closableDupeUrls, [repository])
  assert.equal(vm.closableExtras, 1)
  assert.equal(chip.dupeCount, 2)
  assert.equal(chip.titleVariantPresentations, undefined)
})

test('dashboards with different filter params collapse into one closable Tab Out duplicate', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, active: true, isTabOut: true }),
        makeDashboardTab({ id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 1, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('current and ordinary Tab Out aliases share one closable identity while staying in separate state buckets', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const newTab = 'chrome://newtab/'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: base, title: 'Tab Out', windowId: 1, active: true, isTabOut: true }),
        makeDashboardTab({ id: 2, url: newTab, title: 'New Tab', windowId: 1, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
    const chips = collectDashboardChips(vm)

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
    assert.deepEqual(chips.map((chip) => chip.tabUrl).toSorted(), [base, newTab].toSorted())
    assert.deepEqual(chips.map((chip) => chip.dupeCount), [1, 1])
    assert.equal(chips.find((chip) => chip.tabUrl === base)?.isCurrentTabOut, true)
    assert.equal(chips.find((chip) => chip.tabUrl === newTab)?.isCurrentTabOut, false)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('ordinary Tab Out aliases collapse into one stacked display chip', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: base, title: 'Tab Out', windowId: 2, isTabOut: true }),
        makeDashboardTab({ id: 2, url: 'chrome://newtab/', title: 'New Tab', windowId: 2, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
    const chips = collectDashboardChips(vm)

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
    assert.equal(chips.length, 1)
    assert.equal(chips[0]?.dupeCount, 2)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('an ordinary Tab Out bucket keeps its render identity when its representative closes', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const newTab = 'chrome://newtab/'
    const makeGroup = (tabs: DomainGroup['tabs']): DomainGroup => ({
      domain: '__tab-out__',
      tabs,
    })
    const before = collectDashboardChips(computeDomainCardViewModel(makeGroup([
      makeDashboardTab({ id: 20, url: base, title: 'Tab Out', windowId: 2, isTabOut: true }),
      makeDashboardTab({ id: 21, url: newTab, title: 'New Tab', windowId: 2, isTabOut: true }),
    ]), { currentWindowId: 1 }))[0]
    const after = collectDashboardChips(computeDomainCardViewModel(makeGroup([
      makeDashboardTab({ id: 21, url: newTab, title: 'New Tab', windowId: 2, isTabOut: true }),
    ]), { currentWindowId: 1 }))[0]

    assert.ok(before)
    assert.ok(after)
    assert.notEqual(before.tabId, after.tabId)
    assert.notEqual(before.rawUrl, after.rawUrl)
    assert.equal(before.renderKey, `tab-out:${base}\0ordinary`)
    assert.equal(after.renderKey, before.renderKey)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})
