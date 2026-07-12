import { getTab, queryAllTabs, removeTabs, updateTab } from './browser-tabs-gateway.js'
import { requestDashboardRefresh } from './dashboard-controller.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { isGroupedTab } from './groups.js'
import { liveTabsMatchingTarget } from './live-tab-matching.js'
import { buildSuspendUrl, getSuspendTarget, isSuspended, unwrapSuspenderUrl, type SuspendTarget } from './suspension.js'
import { closeDuplicateTabs, closeTabsExact, fetchOpenTabs, snapshotChromeTabs } from './tabs.js'
import { showToast } from './toast.js'
import { tabMatchesSourceFilter } from './filter-match.js'
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

type SuspendDomainTabsOptions = {
  group: DomainGroup
  filter: string
}

type CloseExactTabSectionOptions = {
  urls: string[]
}

type SuspendExactTabSectionOptions = {
  urls: string[]
}

type DedupeTabsOptions = {
  urls: string[]
  preservePinnedTabOut?: boolean
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type CloseChipTargetOptions = {
  tabUrl: string
  tabId?: number | string
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
  const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesSourceFilter(tab, filter)) : group.tabs
  const snapshot = await closeTabsExact(scopedTabs.map((tab) => tab.url), { preserveGroups: true })
  const result = { snapshot }

  await onAfterClose?.(result)
  markClosedTabs(snapshot, `${closedTabsLabel(snapshot.length)} from ${displayName}`)
  await refreshDashboardAfterTabAction()
  return result
}

function domainSuspendTargetUrls({ group, filter }: SuspendDomainTabsOptions): string[] {
  const isTabOutGroup = group.domain === '__tab-out__'
  const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesSourceFilter(tab, filter)) : group.tabs
  return scopedTabs
    .filter((tab) => !isClosedSavedDashboardTab(tab))
    .filter((tab) => !isGroupedTab(tab) && !(isTabOutGroup && tab.pinned))
    .filter((tab) => !tab.suspended)
    .map((tab) => tab.url)
}

export async function suspendDomainTabs(options: SuspendDomainTabsOptions): Promise<{ suspendedCount: number }> {
  const urls = domainSuspendTargetUrls(options)
  if (urls.length === 0) {
    showToast('Nothing to suspend')
    return { suspendedCount: 0 }
  }

  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return { suspendedCount: 0 }
  }

  const urlSet = new Set(urls)
  const isTabOutGroup = options.group.domain === '__tab-out__'
  const allTabs = await queryAllTabs()
  const targets = allTabs.filter((tab) => {
    if (isGroupedTab(tab) || (isTabOutGroup && tab.pinned)) return false
    return urlSet.has(unwrapSuspenderUrl(tab.url || ''))
  })
  const suspendedCount = await applySuspendToTabs(targets, target)

  await fetchOpenTabs()
  await requestDashboardRefresh()
  showToast(suspendedCount === 0 ? 'Nothing to suspend' : suspendedCount === 1 ? 'Tab suspended' : `Suspended ${suspendedCount} tabs`)
  return { suspendedCount }
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

export async function closeChipTarget({ tabUrl, tabId, envs = null, onAfterClose }: CloseChipTargetOptions): Promise<ChipCloseResult> {
  const isFolded = Array.isArray(envs) && envs.length > 0
  const matches = liveTabsMatchingTarget(await queryAllTabs(), { tabUrl, envs })
  const matchCount = matches.length

  let toCloseList: chrome.tabs.Tab[]
  if (isFolded) {
    toCloseList = matches
  } else {
    const exactTab = typeof tabId === 'number' ? matches.find((tab) => tab.id === tabId) : null
    toCloseList = exactTab ? [exactTab] : matches.slice(0, 1)
  }

  const snapshot = toCloseList.length > 0 ? snapshotChromeTabs(toCloseList) : []
  await removeTabs(toCloseList.map((tab) => tab.id).filter((id): id is number => typeof id === 'number'))
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

  const { deleteHistorySourceUrl } = await import('./history-source.js')
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

type SetChipMutedOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
  muted: boolean
}

async function applyMutedToTabs(targets: chrome.tabs.Tab[], muted: boolean): Promise<void> {
  for (const tab of targets) {
    if (typeof tab.id !== 'number') continue
    await updateTab(tab.id, { muted })
  }
}

/**
 * setChipTargetMuted — mute/unmute every open tab a chip represents. Mirrors
 * closeChipTarget's URL matching (effective + raw URL, suspended-aware) but
 * acts on ALL matches so a noisy duplicate can't survive a mute.
 */
export async function setChipTargetMuted({ tabUrl, envs = null, muted }: SetChipMutedOptions): Promise<void> {
  const targets = liveTabsMatchingTarget(await queryAllTabs(), { tabUrl, envs })

  await applyMutedToTabs(targets, muted)
  await fetchOpenTabs()
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  await requestDashboardRefresh()
}

/** setHistoryEntryMuted — mute/unmute the single tab behind a history row. */
export async function setHistoryEntryMuted(tabId: number, muted: boolean): Promise<void> {
  if (!Number.isInteger(tabId)) return
  await updateTab(tabId, { muted })
  await fetchOpenTabs()
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  await requestDashboardRefresh()
}

type SuspendChipTargetOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
}

async function applySuspendToTabs(targets: chrome.tabs.Tab[], target: SuspendTarget): Promise<number> {
  let count = 0
  for (const tab of targets) {
    if (typeof tab.id !== 'number') continue
    if (isSuspended(tab.url)) continue
    const updated = await updateTab(tab.id, {
      url: buildSuspendUrl(target, { url: tab.url || '', title: tab.title || '' })
    })
    if (updated) count += 1
  }
  return count
}

export async function suspendExactTabSection({ urls }: SuspendExactTabSectionOptions): Promise<{ suspendedCount: number }> {
  if (urls.length === 0) {
    showToast('Nothing to suspend')
    return { suspendedCount: 0 }
  }

  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return { suspendedCount: 0 }
  }

  const urlSet = new Set(urls)
  const allTabs = await queryAllTabs()
  const targets = allTabs.filter((tab) => {
    if (isGroupedTab(tab)) return false
    return urlSet.has(unwrapSuspenderUrl(tab.url || ''))
  })
  const suspendedCount = await applySuspendToTabs(targets, target)

  await fetchOpenTabs()
  // Passive refresh: suspending doesn't reorganize cards, so repaint in place.
  await requestDashboardRefresh()
  showToast(suspendedCount === 0 ? 'Nothing to suspend' : suspendedCount === 1 ? 'Tab suspended' : `Suspended ${suspendedCount} tabs`)
  return { suspendedCount }
}

/**
 * suspendChipTarget — redirect every live, not-already-suspended tab a chip
 * represents into the detected suspender. Mirrors setChipTargetMuted's
 * suspender-aware URL matching (effective + raw URL, folded groups = all matches).
 */
export async function suspendChipTarget({ tabUrl, envs = null }: SuspendChipTargetOptions): Promise<void> {
  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return
  }

  const matches = liveTabsMatchingTarget(await queryAllTabs(), { tabUrl, envs })

  const count = await applySuspendToTabs(matches, target)
  await fetchOpenTabs()
  // Passive refresh: suspending doesn't reorganize cards, so repaint in place.
  await requestDashboardRefresh()
  showToast(count === 0 ? 'Nothing to suspend' : count === 1 ? 'Tab suspended' : `Suspended ${count} tabs`)
}

/** suspendHistoryEntry — redirect the single tab behind a history row into the suspender. */
export async function suspendHistoryEntry(tabId: number): Promise<void> {
  if (!Number.isInteger(tabId)) return
  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return
  }
  const tab = await getTab(tabId)
  if (!tab) {
    showToast('Could not suspend tab')
    return
  }
  if (isSuspended(tab.url)) {
    showToast('Already suspended')
    return
  }
  const updated = await updateTab(tabId, {
    url: buildSuspendUrl(target, { url: tab.url || '', title: tab.title || '' })
  })
  if (!updated) {
    showToast('Could not suspend tab')
    return
  }
  await fetchOpenTabs()
  await requestDashboardRefresh()
  showToast('Tab suspended')
}
