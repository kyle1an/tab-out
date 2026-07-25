import { duplicateTab, getTab, queryAllTabsResult, reloadTab, updateTab } from './browser-tabs-gateway.js'
import { requestDashboardRefresh, settleDashboardRefresh } from './dashboard-controller.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { isGroupedTab } from './groups.js'
import { liveTabMatchesIdentity, liveTabsMatchingTarget, liveTabUrlForIdentity } from './live-tab-matching.js'
import { buildSuspendUrl, getSuspendTarget, isSuspended, unwrapSuspenderUrl, type SuspendTarget } from './suspension.js'
import { closeDuplicateTabsResult, closeResolvedTabsResult, closeTabsByTargetsResult, closeTabsExactResult, type TabCloseResult } from './tabs.js'
import { showToast } from './toast.js'
import { tabMatchesSourceFilter } from './filter-match.js'
import { markClosure } from './undo.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import type { DashboardChipEnv, DashboardTab, DashboardTabMutationTarget, DomainGroup, TabSnapshot } from './types'

type TabActionResult = Omit<TabCloseResult, 'value'> & {
  snapshot: TabSnapshot[]
}

type ChipCloseResult = TabActionResult & {
  shouldAnimateRemoval: boolean
}

type HistoryDeleteResult = {
  ok: boolean
  deletedCount: number
}

type SuspendTabsResult = {
  ok: boolean
  suspendedCount: number
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

type ExactTabTargetsOptions = {
  targets: DashboardTabMutationTarget[]
}

type DedupeTabsOptions = {
  urls: string[]
  preservePinnedTabOut?: boolean
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type CloseChipTargetOptions = {
  tabUrl: string
  tabId?: number | string
  expectedPinned?: boolean
  expectedGroupId?: number
  envs?: DashboardChipEnv[] | null
  onAfterClose?: (result: ChipCloseResult) => void | Promise<void>
}

type DeleteHistoryUrlsOptions = {
  urls: string[]
  onAfterDelete?: (result: HistoryDeleteResult) => void | Promise<void>
}

type ChromeMenuTabTarget = {
  tabUrl: string
  tabId?: number | string
  rawUrl?: string
}

type ChromeMenuTabResolution =
  | { status: 'matched'; tab: chrome.tabs.Tab }
  | { status: 'not-found'; tab: null }
  | { status: 'unknown'; tab: null }

type ChromeMenuActionResult = boolean | 'unknown'

function closedTabsLabel(count: number): string {
  return `Closed ${count} tab${count !== 1 ? 's' : ''}`
}

function closedDuplicatesLabel(count: number): string {
  return `Closed ${count} duplicate${count !== 1 ? 's' : ''}`
}

export function tabCloseProgressLabel(
  removedCount: number,
  attemptedCount: number,
  kind: 'tabs' | 'duplicates' = 'tabs'
): string {
  const singular = kind === 'duplicates' ? 'duplicate' : 'tab'
  const plural = kind
  if (removedCount === 0) {
    return attemptedCount === 1 ? `Could not close ${singular}` : `Could not close ${attemptedCount} ${plural}`
  }
  if (removedCount < attemptedCount) return `Closed ${removedCount} of ${attemptedCount} ${plural}`
  return kind === 'duplicates' ? closedDuplicatesLabel(removedCount) : closedTabsLabel(removedCount)
}

function showOpenTabsReadError(): void {
  showToast('Could not read open tabs')
}

export function historyDeleteToastMessage(deletedCount: number, requestedCount: number): string {
  if (deletedCount === 0) return 'Could not delete history'
  if (deletedCount < requestedCount) return `Deleted ${deletedCount} of ${requestedCount} history items`
  return deletedCount === 1 ? 'History deleted' : `Deleted ${deletedCount} history items`
}

export function historyEntryMuteFailureToastMessage(muted: boolean): string {
  return muted ? 'Could not mute tab' : 'Could not unmute tab'
}

function refreshDashboardAfterTabAction(): void {
  void settleDashboardRefresh(requestDashboardRefresh({ animateCards: true }))
}

function tabActionResult(closeResult: TabCloseResult): TabActionResult {
  const { value, ...metadata } = closeResult
  return { ...metadata, snapshot: value }
}

function emptyTabActionResult(): TabActionResult {
  return {
    ok: true,
    status: 'complete',
    snapshot: [],
    attemptedCount: 0,
    removedCount: 0,
    failedCount: 0
  }
}

async function finishTabCloseAction({
  closeResult,
  kind = 'tabs',
  nothingMessage,
  labelSuffix = '',
  onAfterClose
}: {
  closeResult: TabCloseResult
  kind?: 'tabs' | 'duplicates'
  nothingMessage: string
  labelSuffix?: string
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}): Promise<TabActionResult> {
  const result = tabActionResult(closeResult)
  if (closeResult.status === 'unknown') {
    showOpenTabsReadError()
    return result
  }

  if (closeResult.attemptedCount === 0) {
    showToast(nothingMessage)
    await onAfterClose?.(result)
    return result
  }

  const label = `${tabCloseProgressLabel(closeResult.removedCount, closeResult.attemptedCount, kind)}${labelSuffix}`
  if (closeResult.removedCount === 0) {
    showToast(label)
    await onAfterClose?.(result)
    return result
  }

  if (result.snapshot.length > 0) markClosedTabs(result.snapshot, label)
  else showToast(label)
  await onAfterClose?.(result)
  refreshDashboardAfterTabAction()
  return result
}

function markClosedTabs(snapshot: TabSnapshot[], label: string): void {
  if (snapshot.length === 0) return
  markClosure(snapshot, label)
}

export async function closeFilteredTabs(targets: DashboardTabMutationTarget[]): Promise<TabActionResult> {
  if (targets.length === 0) {
    showToast('Nothing to close')
    return emptyTabActionResult()
  }

  const closeResult = await closeTabsByTargetsResult(targets, { preserveGroups: true })
  return finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
}

export async function closeDomainTabs({ group, filter, displayName, onAfterClose }: CloseDomainTabsOptions): Promise<TabActionResult> {
  const isTabOutGroup = group.domain === '__tab-out__'
  const scopedTabs = (filter ? group.tabs.filter((tab) => tabMatchesSourceFilter(tab, filter)) : group.tabs)
    .filter((tab) => !isClosedSavedDashboardTab(tab))
    .filter((tab) => !isGroupedTab(tab) && !(isTabOutGroup && tab.pinned))
  const closeResult = await closeTabsByTargetsResult(tabMutationTargets(scopedTabs), { preserveGroups: true })
  return finishTabCloseAction({
    closeResult,
    nothingMessage: 'Nothing to close',
    labelSuffix: ` from ${displayName}`,
    ...(onAfterClose ? { onAfterClose } : {})
  })
}

function tabMutationTargets(tabs: readonly DashboardTab[]): DashboardTabMutationTarget[] {
  return tabs.flatMap((tab) => typeof tab.id === 'number'
    ? [{ tabId: tab.id, tabUrl: tab.url }]
    : [])
}

function domainSuspendTargets({ group, filter }: SuspendDomainTabsOptions): DashboardTabMutationTarget[] {
  const isTabOutGroup = group.domain === '__tab-out__'
  const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesSourceFilter(tab, filter)) : group.tabs
  return tabMutationTargets(scopedTabs
    .filter((tab) => !isClosedSavedDashboardTab(tab))
    .filter((tab) => !isGroupedTab(tab) && !(isTabOutGroup && tab.pinned))
    .filter((tab) => !tab.suspended))
}

export async function suspendDomainTabs(options: SuspendDomainTabsOptions): Promise<SuspendTabsResult> {
  return suspendMutationTargets(domainSuspendTargets(options))
}

async function suspendMutationTargets(targets: readonly DashboardTabMutationTarget[]): Promise<SuspendTabsResult> {
  if (targets.length === 0) {
    showToast('Nothing to suspend')
    return { ok: true, suspendedCount: 0 }
  }

  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return { ok: true, suspendedCount: 0 }
  }

  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return { ok: false, suspendedCount: 0 }
  }
  const liveTargets = liveTabsForMutationTargets(allTabsResult.value, targets)
    .filter((tab) => !isGroupedTab(tab))
    .filter((tab) => !(tab.pinned && isTabOutPageUrl(unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))))
  const updateResult = await applySuspendToTabs(liveTargets, target)
  const ok = await finishSuspendUpdates(updateResult)
  return { ok, suspendedCount: updateResult.updatedCount }
}

export async function closeExactTabSection({ urls }: CloseExactTabSectionOptions): Promise<TabActionResult> {
  const closeResult = await closeTabsExactResult(urls, { preserveGroups: true })
  return finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
}

export async function closeExactTabTargets({ targets }: ExactTabTargetsOptions): Promise<TabActionResult> {
  const closeResult = await closeTabsByTargetsResult(targets, { preserveGroups: true })
  return finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
}

export async function dedupeTabs({ urls, preservePinnedTabOut = false, onAfterClose }: DedupeTabsOptions): Promise<TabActionResult> {
  if (urls.length === 0) return emptyTabActionResult()

  const closeResult = await closeDuplicateTabsResult(urls, true, { preservePinnedTabOut })
  return finishTabCloseAction({
    closeResult,
    kind: 'duplicates',
    nothingMessage: 'Nothing to dedupe',
    ...(onAfterClose ? { onAfterClose } : {})
  })
}

export async function closeChipTarget({
  tabUrl,
  tabId,
  expectedPinned,
  expectedGroupId,
  envs = null,
  onAfterClose
}: CloseChipTargetOptions): Promise<ChipCloseResult> {
  const isFolded = Array.isArray(envs) && envs.length > 0
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return {
      ok: false,
      status: 'unknown',
      snapshot: [],
      attemptedCount: 0,
      removedCount: 0,
      failedCount: 0,
      shouldAnimateRemoval: false
    }
  }
  const matches = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })
  const matchCount = matches.length

  let toCloseList: chrome.tabs.Tab[]
  if (isFolded) {
    toCloseList = matches
  } else {
    const exactTab = typeof tabId === 'number'
      ? matches.find((tab) => (
          tab.id === tabId &&
          (expectedPinned === undefined || !!tab.pinned === expectedPinned) &&
          (expectedGroupId === undefined || tab.groupId === expectedGroupId)
        ))
      : null
    // A numeric id represents one physical Chrome tab. If that tab disappeared
    // or Chrome reused the id for a different URL, do not fall through to a
    // same-URL sibling and close a different chip's target.
    toCloseList = typeof tabId === 'number'
      ? exactTab ? [exactTab] : []
      : matches.slice(0, 1)
  }

  const closeResult = await closeResolvedTabsResult(toCloseList, { includeTabOutUrls: true })

  const result = {
    ...tabActionResult(closeResult),
    shouldAnimateRemoval: closeResult.ok && closeResult.removedCount > 0 && (isFolded ? closeResult.removedCount === matchCount : matchCount <= 1)
  }

  if (closeResult.removedCount > 0) {
    const label = isFolded
      ? `${tabCloseProgressLabel(closeResult.removedCount, closeResult.attemptedCount)} across subdomains`
      : 'Tab closed'
    if (result.snapshot.length > 0) markClosure(result.snapshot, label)
    else showToast(label)
  } else if (closeResult.attemptedCount > 0) {
    showToast(tabCloseProgressLabel(0, closeResult.attemptedCount))
  } else {
    showToast('Nothing to close')
  }

  await onAfterClose?.(result)
  if (closeResult.removedCount > 0) refreshDashboardAfterTabAction()

  return result
}

export async function deleteHistoryUrls({ urls, onAfterDelete }: DeleteHistoryUrlsOptions): Promise<HistoryDeleteResult> {
  if (urls.length === 0) return { ok: true, deletedCount: 0 }

  const { deleteHistorySourceUrl } = await import('./history-source.js')
  const results = await Promise.all(urls.map((url) => deleteHistorySourceUrl(url)))
  const deletedCount = results.filter(Boolean).length
  const result = { ok: deletedCount === urls.length, deletedCount }

  if (deletedCount === 0) {
    showToast(historyDeleteToastMessage(deletedCount, urls.length))
    return result
  }

  await onAfterDelete?.(result)
  await refreshDashboardAfterTabAction()
  showToast(historyDeleteToastMessage(deletedCount, urls.length))
  return result
}

async function resolveChromeMenuTabTarget({ tabUrl, tabId, rawUrl }: ChromeMenuTabTarget): Promise<ChromeMenuTabResolution> {
  if (tabId !== undefined) {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return { status: 'not-found', tab: null }
    const tab = await getTab(tabId)
    return tab && liveTabMatchesIdentity(tab, { tabId, tabUrl, rawUrl })
      ? { status: 'matched', tab }
      : { status: 'not-found', tab: null }
  }
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return { status: 'unknown', tab: null }
  const [match] = liveTabsMatchingTarget(allTabsResult.value, { tabUrl })
  return match ? { status: 'matched', tab: match } : { status: 'not-found', tab: null }
}

export async function reloadTabTarget(target: ChromeMenuTabTarget): Promise<ChromeMenuActionResult> {
  const resolution = await resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (typeof tab?.id !== 'number' || !(await reloadTab(tab.id))) {
    showToast('Could not reload tab')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab reloaded')
  return true
}

export async function duplicateTabTarget(target: ChromeMenuTabTarget): Promise<ChromeMenuActionResult> {
  const resolution = await resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (typeof tab?.id !== 'number' || !(await duplicateTab(tab.id))) {
    showToast('Could not duplicate tab')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab duplicated')
  return true
}

type SetChipMutedOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
  muted: boolean
}

type TabUpdateSummary = {
  attemptedCount: number
  updatedCount: number
}

async function revalidateMutationTarget(snapshot: chrome.tabs.Tab): Promise<chrome.tabs.Tab | null> {
  if (typeof snapshot.id !== 'number') return null
  const liveTab = await getTab(snapshot.id)
  if (!liveTab || !liveTabMatchesIdentity(liveTab, {
    tabId: snapshot.id,
    rawUrl: liveTabUrlForIdentity(snapshot)
  })) return null
  return liveTab
}

async function applyMutedToTabs(targets: chrome.tabs.Tab[], muted: boolean): Promise<TabUpdateSummary> {
  let attemptedCount = 0
  let updatedCount = 0
  for (const snapshot of targets) {
    if (typeof snapshot.id !== 'number') continue
    attemptedCount += 1
    const liveTab = await revalidateMutationTarget(snapshot)
    if (typeof liveTab?.id !== 'number') continue
    if (await updateTab(liveTab.id, { muted })) updatedCount += 1
  }
  return { attemptedCount, updatedCount }
}

/**
 * setChipTargetMuted — mute/unmute every open tab a chip represents. Mirrors
 * closeChipTarget's URL matching (effective + raw URL, suspended-aware) but
 * acts on ALL matches so a noisy duplicate can't survive a mute.
 */
export async function setChipTargetMuted({ tabUrl, envs = null, muted }: SetChipMutedOptions): Promise<boolean> {
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return false
  }
  const targets = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })

  const updateResult = await applyMutedToTabs(targets, muted)
  if (updateResult.attemptedCount === 0) return true
  if (updateResult.updatedCount === 0) {
    showToast(muted ? 'Could not mute tabs' : 'Could not unmute tabs')
    return false
  }
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  void settleDashboardRefresh(requestDashboardRefresh())
  if (updateResult.updatedCount < updateResult.attemptedCount) {
    showToast(`${muted ? 'Muted' : 'Unmuted'} ${updateResult.updatedCount} of ${updateResult.attemptedCount} tabs`)
    return false
  }
  return true
}

/** setHistoryEntryMuted — mute/unmute the single tab behind a history row. */
export async function setHistoryEntryMuted(target: ChromeMenuTabTarget, muted: boolean): Promise<ChromeMenuActionResult> {
  const resolution = await resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (typeof tab?.id !== 'number') return false
  if (!(await updateTab(tab.id, { muted }))) {
    showToast(historyEntryMuteFailureToastMessage(muted))
    return false
  }
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  void settleDashboardRefresh(requestDashboardRefresh())
  return true
}

type SuspendChipTargetOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
}

async function applySuspendToTabs(targets: chrome.tabs.Tab[], target: SuspendTarget): Promise<TabUpdateSummary> {
  let attemptedCount = 0
  let updatedCount = 0
  for (const snapshot of targets) {
    if (typeof snapshot.id !== 'number') continue
    if (isSuspended(liveTabUrlForIdentity(snapshot))) continue
    attemptedCount += 1
    const liveTab = await revalidateMutationTarget(snapshot)
    const liveUrl = liveTab ? liveTabUrlForIdentity(liveTab) : ''
    if (typeof liveTab?.id !== 'number' || isSuspended(liveUrl)) continue
    const updated = await updateTab(liveTab.id, {
      url: buildSuspendUrl(target, { url: liveUrl, title: liveTab.title || '' })
    })
    if (updated) updatedCount += 1
  }
  return { attemptedCount, updatedCount }
}

async function finishSuspendUpdates({ attemptedCount, updatedCount }: TabUpdateSummary): Promise<boolean> {
  if (attemptedCount === 0) {
    showToast('Nothing to suspend')
    return true
  }
  if (updatedCount === 0) {
    showToast(attemptedCount === 1 ? 'Could not suspend tab' : 'Could not suspend tabs')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  if (updatedCount < attemptedCount) {
    showToast(`Suspended ${updatedCount} of ${attemptedCount} tabs`)
    return false
  }
  showToast(updatedCount === 1 ? 'Tab suspended' : `Suspended ${updatedCount} tabs`)
  return true
}

function liveTabsForMutationTargets(
  liveTabs: readonly chrome.tabs.Tab[],
  targets: readonly DashboardTabMutationTarget[]
): chrome.tabs.Tab[] {
  const expectedUrlById = new Map(targets.map((target) => [target.tabId, target.tabUrl]))
  return liveTabs.filter((tab) => typeof tab.id === 'number' &&
    expectedUrlById.get(tab.id) === unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))
}

export async function suspendExactTabTargets({ targets }: ExactTabTargetsOptions): Promise<SuspendTabsResult> {
  return suspendMutationTargets(targets)
}

/**
 * suspendChipTarget — redirect every live, not-already-suspended tab a chip
 * represents into the detected suspender. Mirrors setChipTargetMuted's
 * suspender-aware URL matching (effective + raw URL, folded groups = all matches).
 */
export async function suspendChipTarget({ tabUrl, envs = null }: SuspendChipTargetOptions): Promise<boolean> {
  const target = await getSuspendTarget()
  if (!target) {
    showToast('No suspender detected')
    return false
  }

  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return false
  }
  const matches = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })

  return finishSuspendUpdates(await applySuspendToTabs(matches, target))
}

/** suspendHistoryEntry — redirect the single tab behind a history row into the suspender. */
export async function suspendHistoryEntry(entryTarget: ChromeMenuTabTarget): Promise<ChromeMenuActionResult> {
  const suspendTarget = await getSuspendTarget()
  if (!suspendTarget) {
    showToast('No suspender detected')
    return false
  }
  const resolution = await resolveChromeMenuTabTarget(entryTarget)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (!tab || typeof tab.id !== 'number') {
    showToast('Could not suspend tab')
    return false
  }
  const liveUrl = liveTabUrlForIdentity(tab)
  if (isSuspended(liveUrl)) {
    showToast('Already suspended')
    return false
  }
  const updated = await updateTab(tab.id, {
    url: buildSuspendUrl(suspendTarget, { url: liveUrl, title: tab.title || '' })
  })
  if (!updated) {
    showToast('Could not suspend tab')
    return false
  }
  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab suspended')
  return true
}
