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

test('two Jira URL forms of the same comment collapse into one closable duplicate', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [makeTab({ id: 1, url: longForm }), makeTab({ id: 2, url: shortForm })]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls, ['https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'])

  const jiraChips = collectChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 1)
})

test('different focused comments on the same issue are not treated as duplicates', () => {
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeTab({ id: 1, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100' }),
      makeTab({ id: 2, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200' })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls ?? [], [])
  const jiraChips = collectChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 2)
})
