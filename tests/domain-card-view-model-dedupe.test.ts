import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import type { DomainGroup } from '../src/extension/types'
import { collectDashboardChips, makeDashboardTab } from './helpers/domain-card-view-model.js'

test('two Jira URL forms of the same comment collapse into one closable duplicate', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [makeDashboardTab({ id: 1, url: longForm }), makeDashboardTab({ id: 2, url: shortForm })]
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
      makeDashboardTab({ id: 2, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200' })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls ?? [], [])
  const jiraChips = collectDashboardChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 2)
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
        makeDashboardTab({ id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 1, isTabOut: true })
      ]
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})
