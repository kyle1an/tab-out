import { requestDashboardRefresh } from './dashboard-controller.js'
import { deleteHistorySourceUrl } from './history-source.js'
import { unwrapSuspenderUrl } from './suspender.js'
import { closeDuplicateTabs, closeTabsExact, fetchOpenTabs, snapshotChromeTabs } from './tabs.js'
import { showToast } from './toast.js'
import { tabMatchesFilter } from './filter-match.js'
import { markClosure } from './undo.js'
import type { DashboardChipEnv, DomainGroup, TabSnapshot } from './types'

type TabActionResult = {
  snapshot: TabSnapshot[]
}

type ChipCloseResult = TabActionResult & {
  shouldAnimateRemoval: boolean
}

type HistoryDeleteResult = {
  deletedCount: number
}

type CloseDomainTabsOptions = {
  group: DomainGroup
  filter: string
  displayName: string
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type CloseExactTabSectionOptions = {
  urls: string[]
}

type DedupeTabsOptions = {
  urls: string[]
  preservePinnedTabOut?: boolean
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type CloseChipTargetOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
  onAfterClose?: (result: ChipCloseResult) => void | Promise<void>
}

type DeleteHistoryUrlsOptions = {
  urls: string[]
  onAfterDelete?: (result: HistoryDeleteResult) => void | Promise<void>
}

function closedTabsLabel(count: number): string {
  return `Closed ${count} tab${count !== 1 ? 's' : ''}`
}

function closedDuplicatesLabel(count: number): string {
  return `Closed ${count} duplicate${count !== 1 ? 's' : ''}`
}

async function refreshDashboardAfterTabAction(): Promise<void> {
  await requestDashboardRefresh({ animateCards: true })
}

function markClosedTabs(snapshot: TabSnapshot[], label: string): void {
  if (snapshot.length === 0) return
  markClosure(snapshot, label)
}

export async function closeFilteredTabs(urls: string[]): Promise<TabActionResult> {
  if (urls.length === 0) {
    showToast('Nothing to close')
    return { snapshot: [] }
  }

  const snapshot = await closeTabsExact(urls, { preserveGroups: true })
  if (snapshot.length > 0) markClosure(snapshot, closedTabsLabel(snapshot.length))
  else showToast('Nothing to close')
  await refreshDashboardAfterTabAction()
  return { snapshot }
}

export async function closeDomainTabs({ group, filter, displayName, onAfterClose }: CloseDomainTabsOptions): Promise<TabActionResult> {
  const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesFilter(tab, filter)) : group.tabs
  const snapshot = await closeTabsExact(scopedTabs.map((tab) => tab.url), { preserveGroups: true })
  const result = { snapshot }

  await onAfterClose?.(result)
  markClosedTabs(snapshot, `${closedTabsLabel(snapshot.length)} from ${displayName}`)
  await refreshDashboardAfterTabAction()
  return result
}

export async function closeExactTabSection({ urls }: CloseExactTabSectionOptions): Promise<TabActionResult> {
  const snapshot = await closeTabsExact(urls, { preserveGroups: true })

  markClosedTabs(snapshot, closedTabsLabel(snapshot.length))
  await refreshDashboardAfterTabAction()
  return { snapshot }
}

export async function dedupeTabs({ urls, preservePinnedTabOut = false, onAfterClose }: DedupeTabsOptions): Promise<TabActionResult> {
  if (urls.length === 0) return { snapshot: [] }

  const snapshot = await closeDuplicateTabs(urls, true, { preservePinnedTabOut })
  const result = { snapshot }

  await onAfterClose?.(result)
  markClosedTabs(snapshot, closedDuplicatesLabel(snapshot.length))
  await refreshDashboardAfterTabAction()
  return result
}

export async function closeChipTarget({ tabUrl, envs = null, onAfterClose }: CloseChipTargetOptions): Promise<ChipCloseResult> {
  const foldedEnvs = Array.isArray(envs) ? envs : []
  const isFolded = foldedEnvs.length > 0
  const allTabs = await chrome.tabs.query({})
  let toCloseList: chrome.tabs.Tab[] = []
  let matchCount = 0

  if (isFolded) {
    const targetEffectives = new Set(foldedEnvs.map((env) => unwrapSuspenderUrl(env.tabUrl)))
    const targetUrls = new Set(foldedEnvs.map((env) => env.tabUrl))
    toCloseList = allTabs.filter((tab) => {
      const openTabUrl = tab.url || ''
      return targetUrls.has(openTabUrl) || targetEffectives.has(unwrapSuspenderUrl(openTabUrl))
    })
    matchCount = toCloseList.length
  } else {
    const targetEffective = unwrapSuspenderUrl(tabUrl)
    const matches = allTabs.filter((tab) => {
      const openTabUrl = tab.url || ''
      return openTabUrl === tabUrl || unwrapSuspenderUrl(openTabUrl) === targetEffective
    })
    toCloseList = matches.slice(0, 1)
    matchCount = matches.length
  }

  const snapshot = toCloseList.length > 0 ? snapshotChromeTabs(toCloseList) : []
  for (const tab of toCloseList) {
    if (typeof tab.id !== 'number') continue
    try {
      await chrome.tabs.remove(tab.id)
    } catch {}
  }
  await fetchOpenTabs()

  const result = {
    snapshot,
    shouldAnimateRemoval: isFolded || matchCount <= 1
  }

  await onAfterClose?.(result)
  await refreshDashboardAfterTabAction()

  if (snapshot.length > 0) {
    const label = isFolded ? `${closedTabsLabel(snapshot.length)} across subdomains` : 'Tab closed'
    markClosure(snapshot, label)
  } else {
    showToast('Nothing to close')
  }

  return result
}

export async function deleteHistoryUrls({ urls, onAfterDelete }: DeleteHistoryUrlsOptions): Promise<HistoryDeleteResult> {
  if (urls.length === 0) return { deletedCount: 0 }

  const results = await Promise.all(urls.map((url) => deleteHistorySourceUrl(url)))
  const deletedCount = results.filter(Boolean).length
  const result = { deletedCount }

  if (deletedCount === 0) {
    showToast('Could not delete history')
    return result
  }

  await onAfterDelete?.(result)
  await refreshDashboardAfterTabAction()
  showToast(deletedCount === 1 ? 'History deleted' : `Deleted ${deletedCount} history items`)
  return result
}
