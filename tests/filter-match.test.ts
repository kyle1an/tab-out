import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import {
  getFilteredCloseableTabsForQuery,
  tabMatchesCompiledFilter,
  tabMatchesFilter
} from '../src/extension/filter-match.js'
import { compileFilterQuery } from '../src/extension/filter-query.js'
import type { DashboardTab } from '../src/extension/types.js'

function makeTab(overrides: Partial<DashboardTab> & { url: string }): DashboardTab {
  return {
    id: 1,
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: '',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...overrides
  }
}

test('compiled filter matching preserves token, phrase, separator, alias, and literal-minus semantics', () => {
  const cases: Array<{
    name: string
    tab: DashboardTab
    filter: string
    expected: boolean
  }> = [
    {
      name: 'spaces match hyphens',
      tab: makeTab({ url: 'https://example.test/guide', title: 'Tab-Out guide' }),
      filter: 'tab out',
      expected: true
    },
    {
      name: 'hyphens match spaces in phrases',
      tab: makeTab({ url: 'https://example.test/guide', title: 'Tab Out guide' }),
      filter: '"tab-out"',
      expected: true
    },
    {
      name: 'quoted phrases preserve word order',
      tab: makeTab({ url: 'https://example.test/reviews/42', title: 'Pull Request review' }),
      filter: '"request pull"',
      expected: false
    },
    {
      name: 'token aliases remain available',
      tab: makeTab({ url: 'https://example.test/reviews/42', title: 'Pull Request review' }),
      filter: 'pr 42',
      expected: true
    },
    {
      name: 'terms may match across title and URL',
      tab: makeTab({ url: 'https://example.test/docs/reference', title: 'API guide' }),
      filter: 'api reference',
      expected: true
    },
    {
      name: 'a missing term keeps AND semantics negative',
      tab: makeTab({ url: 'https://example.test/docs/reference', title: 'API guide' }),
      filter: 'api missing',
      expected: false
    },
    {
      name: 'a leading minus remains a literal token',
      tab: makeTab({ url: 'https://example.test/docs', title: 'Legacy guide' }),
      filter: '-legacy',
      expected: false
    },
    {
      name: 'a literal leading minus can still match',
      tab: makeTab({ url: 'https://example.test/-legacy', title: 'Guide' }),
      filter: '-legacy',
      expected: true
    }
  ]

  for (const { name, tab, filter, expected } of cases) {
    const compiled = compileFilterQuery(filter)
    assert.equal(tabMatchesCompiledFilter(tab, compiled), expected, name)
    assert.equal(tabMatchesFilter(tab, filter), expected, `${name} through compatibility wrapper`)
  }
})

test('filter tokens matching Object prototype properties remain literal search terms', () => {
  for (const filter of ['constructor', '__proto__']) {
    const compiled = compileFilterQuery(filter)

    assert.deepEqual(compiled.terms[0]?.matchValues, [filter])
    assert.equal(
      tabMatchesCompiledFilter(
        makeTab({ url: `https://example.test/${filter}`, title: 'Example page' }),
        compiled
      ),
      true
    )
  }
})

test('one compiled query serves every item, matching card, and filtered-close pass', () => {
  let compileCount = 0
  const compileOnce = (filter: string) => {
    compileCount += 1
    return compileFilterQuery(filter)
  }
  const filter = 'docs "tab out"'
  const query = compileOnce(filter)
  const tabs = Array.from({ length: 240 }, (_, index) => makeTab({
    id: index + 1,
    url: `https://example.test/docs/${index}`,
    title: index % 2 === 0 ? `Tab-Out guide ${index}` : `Other guide ${index}`
  }))

  const directMatches = tabs.filter((tab) => tabMatchesCompiledFilter(tab, query))
  const matchedCard = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    { filter, filterQuery: query }
  )
  const filteredCloseTabs = getFilteredCloseableTabsForQuery(tabs, query)

  assert.equal(compileCount, 1)
  assert.equal(directMatches.length, 120)
  assert.equal(matchedCard.tabCount, 120)
  assert.equal(filteredCloseTabs.length, 120)
})
