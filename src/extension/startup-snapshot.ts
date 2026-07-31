import type { ClosedTabEntry } from './closed-tabs.js'
import { domainGroupCardId } from './domain-card-id.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { isPinnableDomain, normalizePinnedDomains } from './domain-pins.js'
import {
  DASHBOARD_LOCAL_STORAGE_KEYS,
  sameDashboardLocalState,
  validDashboardLocalStateFromStorage,
  type DashboardLocalState
} from './dashboard-local-state.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import { buildDashboardDataFromTabs } from './render.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { buildWorkingSetSnapshot, pageIdentityForWorkingSet } from './working-set.js'
import { normalizeWorkingSetSnapshot } from './working-set-client.js'
import type { SavedPageMetadataUpdates, SavedPagesStore } from './saved-pages.js'
import type { DashboardData, DashboardTab, DashboardViewModel, DomainGroup, TabHistorySnapshot, WorkingSetActivityStore, WorkingSetSnapshot } from './types'

export type DashboardStartupViewModel = {
  pinnedDomains: readonly string[]
  pinnedPageChipIds: readonly string[]
  pinnedSectionIds: readonly string[]
  viewModel: DashboardViewModel
}
export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
  startupViewModel?: DashboardStartupViewModel
}
export type CachedDashboardStartup = {
  snapshot: DashboardStartupSnapshot
  localState: DashboardLocalState | null
}
export type CachedDashboardStartupLoadResult = {
  ok: boolean
  value: CachedDashboardStartup | null
}
type CachedDashboardStartupSnapshot = {
  savedAt: number
  captureStartedAt?: number
  contentFingerprint?: string
  workingSetSavedAt?: number
  snapshot: DashboardStartupSnapshot
  localState?: DashboardLocalState
}
type SaveCachedDashboardStartupOptions = {
  buildStartupViewModel?: (snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null) => DashboardStartupViewModel
  captureStartedAt?: number
  durableCheckpointIntervalMs?: number
  now?: number
  scheduleDurableCheckpoint?: (when: number) => Promise<void> | void
}

// Everything cached under this key crosses chrome.storage, which is JSON-only:
// Maps/Sets/Dates silently degrade ({} / {} / string) and revive wrong, so the
// snapshot and its startupViewModel must stay plain JSON data (records, arrays,
// primitives — see the title-suppression tone records). Bump the :vN suffix
// whenever the cached shape changes in a way the readers below cannot digest;
// old-version entries are simply never read again and age out.
export const DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = 'tab-out:startup-snapshot:v1'
// How long the first-paint Working Set priority stays frozen across reopens before the next
// live hydration adopts a fresh Working Set. Longer keeps chip/section ordering stable across
// reopens at the cost of staler prioritization; capped in practice by the browser session
// because chrome.storage.session clears on restart.
export const DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS = 30 * 60_000
// Durable Checkpoint cap. chrome.storage.session is cleared on browser restart, so the
// source-only chrome.storage.local copy lets the first open after a restart derive the last
// checkpointed grouping before live hydration; a long-abandoned checkpoint is not shown.
export const DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const DASHBOARD_STARTUP_SNAPSHOT_CACHE_WRITE_LOCK = 'tab-out:startup-snapshot-cache-write'

let startupSnapshotCacheMutationQueue: Promise<void> = Promise.resolve()

// performance.timeOrigin + performance.now() is comparable across extension pages and the
// service worker while retaining more ordering precision than Date.now(). Callers capture it
// before reading browser state, then carry it through the eventual cache write.
export function captureDashboardStartupSnapshotStartedAt(): number {
  const monotonicEpoch = typeof performance === 'undefined'
    ? Number.NaN
    : performance.timeOrigin + performance.now()
  return Number.isFinite(monotonicEpoch) ? monotonicEpoch : Date.now()
}

function startupSnapshotCacheStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.session || null
}

function startupSnapshotDurableStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.local || null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isCachedTabId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' || isFiniteNumber(value)
}

function isCachedDashboardSourceType(value: unknown): boolean {
  return value === undefined || value === 'tab' || value === 'bookmark' || value === 'history' || value === 'saved-page'
}

function isCachedDashboardTab(value: unknown): value is DashboardTab {
  return isObject(value) &&
    isCachedTabId(value.id) &&
    typeof value.url === 'string' &&
    typeof value.rawUrl === 'string' &&
    typeof value.suspended === 'boolean' &&
    typeof value.title === 'string' &&
    (value.status === undefined || value.status === 'unloaded' || value.status === 'loading' || value.status === 'complete') &&
    isOptionalBoolean(value.retainedSuspendedTitle) &&
    typeof value.favIconUrl === 'string' &&
    isFiniteNumber(value.windowId) &&
    typeof value.active === 'boolean' &&
    typeof value.pinned === 'boolean' &&
    isFiniteNumber(value.groupId) &&
    typeof value.isTabOut === 'boolean' &&
    typeof value.isApp === 'boolean' &&
    isOptionalBoolean(value.audible) &&
    isOptionalBoolean(value.muted) &&
    isCachedDashboardSourceType(value.sourceType) &&
    isOptionalBoolean(value.saved) &&
    isOptionalBoolean(value.closedSaved) &&
    isOptionalString(value.savedPageKey) &&
    isOptionalFiniteNumber(value.index)
}

function isCachedDomainGroup(value: unknown): boolean {
  return isObject(value) &&
    typeof value.domain === 'string' &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isCachedDashboardTab) &&
    isOptionalString(value.label) &&
    isOptionalBoolean(value.pinned)
}

function isCachedClosedTab(value: unknown): boolean {
  return isObject(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.lastClosedAt === 'number'
}

function isDashboardStartupSnapshot(value: unknown): value is DashboardStartupSnapshot {
  if (!isObject(value) || !isObject(value.dashboard)) return false
  return (
    Array.isArray(value.dashboard.realTabs) && value.dashboard.realTabs.every(isCachedDashboardTab) &&
    Array.isArray(value.dashboard.domainGroups) && value.dashboard.domainGroups.every(isCachedDomainGroup) &&
    (value.dashboard.bookmarkDomainGroups === undefined || (
      Array.isArray(value.dashboard.bookmarkDomainGroups) && value.dashboard.bookmarkDomainGroups.every(isCachedDomainGroup)
    )) &&
    (value.dashboard.historyDomainGroups === undefined || (
      Array.isArray(value.dashboard.historyDomainGroups) && value.dashboard.historyDomainGroups.every(isCachedDomainGroup)
    )) &&
    (value.tabHistory == null || isObject(value.tabHistory)) &&
    (value.workingSet == null || isObject(value.workingSet)) &&
    Array.isArray(value.closedTabs) && value.closedTabs.every(isCachedClosedTab)
  )
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null
}

function cachedDashboardLocalState(value: unknown): DashboardLocalState | null {
  if (!isObject(value) || value.loaded !== true) return null
  const pinnedDomains = stringArray(value.pinnedDomains)
  const pinnedSectionIds = stringArray(value.pinnedSectionIds)
  const pinnedPageChipIds = stringArray(value.pinnedPageChipIds)
  if (!pinnedDomains || !pinnedSectionIds || !pinnedPageChipIds) return null
  return {
    loaded: true,
    pinnedDomains,
    pinnedSectionIds,
    pinnedPageChipIds
  }
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate)
}

function isStringArray(value: unknown): boolean {
  return isArrayOf(value, (item) => typeof item === 'string')
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value)
}

function isOptionalObjectArray(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return value === undefined || isArrayOf(value, predicate)
}

function isRecordOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return isObject(value) && !Array.isArray(value) && Object.values(value).every(predicate)
}

function isCachedDashboardTitleSuppression(value: unknown): boolean {
  return isObject(value) &&
    typeof value.text === 'string' &&
    isFiniteNumber(value.count) &&
    isOptionalBoolean(value.spansRenderedChildGroups)
}

function isCachedTitleSuppressionTone(value: unknown): boolean {
  return value === '' || value === 'amber' || value === 'teal' || value === 'sky' || value === 'rose'
}

function isCachedTitleSuppressionToneScope(value: unknown): boolean {
  return isObject(value) &&
    typeof value.useSuppressionTokenTones === 'boolean' &&
    isRecordOf(value.suppressedTitleToneIndexByText, isFiniteNumber) &&
    isRecordOf(value.suppressedTitleToneByText, isCachedTitleSuppressionTone) &&
    isFiniteNumber(value.usedToneCount)
}

function isOptionalTitleSuppressionToneScope(value: unknown): boolean {
  return value === undefined || isCachedTitleSuppressionToneScope(value)
}

function isOptionalTitleSuppressionToneRecord(value: unknown): boolean {
  return value === undefined || isRecordOf(value, isCachedTitleSuppressionTone)
}

function isOptionalDashboardTitleSuppressions(value: unknown): boolean {
  return value === undefined || isArrayOf(value, isCachedDashboardTitleSuppression)
}

function isCachedDashboardSegment(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (!isObject(value)) return false
  if (value.placeholder === true) return isOptionalString(value.label)
  return typeof value.titleSuppression === 'string'
}

function isCachedDashboardChipEnv(value: unknown): boolean {
  return isObject(value) &&
    isCachedTabId(value.tabId) &&
    typeof value.prefix === 'string' &&
    typeof value.tabUrl === 'string' &&
    typeof value.rawUrl === 'string' &&
    isCachedDashboardSourceType(value.sourceType) &&
    isOptionalBoolean(value.saved) &&
    isOptionalBoolean(value.closedSaved) &&
    isOptionalString(value.savedPageKey) &&
    isOptionalString(value.title) &&
    isOptionalString(value.faviconUrl) &&
    isOptionalBoolean(value.isApp) &&
    isOptionalBoolean(value.activeInOtherWindow)
}

function isCachedDashboardChip(value: unknown): boolean {
  return isObject(value) &&
    isCachedTabId(value.tabId) &&
    typeof value.tabUrl === 'string' &&
    typeof value.rawUrl === 'string' &&
    isCachedDashboardSourceType(value.sourceType) &&
    isOptionalBoolean(value.saved) &&
    isOptionalBoolean(value.closedSaved) &&
    isOptionalBoolean(value.suspended) &&
    isOptionalBoolean(value.loading) &&
    isOptionalString(value.savedPageKey) &&
    isOptionalString(value.pagePinId) &&
    isOptionalBoolean(value.pagePinned) &&
    isOptionalBoolean(value.pagePinDisabled) &&
    typeof value.leadPrefix === 'string' &&
    typeof value.pathGroupLabel === 'string' &&
    isOptionalString(value.title) &&
    isArrayOf(value.displaySegments, isCachedDashboardSegment) &&
    isStringArray(value.suppressedTitleParts) &&
    typeof value.pathSuffix === 'string' &&
    typeof value.tooltip === 'string' &&
    isFiniteNumber(value.dupeCount) &&
    typeof value.faviconUrl === 'string' &&
    typeof value.isGrouped === 'boolean' &&
    (value.groupDotColor === null || typeof value.groupDotColor === 'string') &&
    typeof value.isApp === 'boolean' &&
    (value.audioState === undefined || value.audioState === null || value.audioState === 'playing' || value.audioState === 'muted') &&
    isOptionalBoolean(value.activeInOtherWindow) &&
    isOptionalBoolean(value.activeChipFrame) &&
    isOptionalBoolean(value.isCurrentTabOut) &&
    isOptionalBoolean(value.chromePinned) &&
    isOptionalFiniteNumber(value.chromeGroupId) &&
    isOptionalBoolean(value.iconOnly) &&
    (value.envs === null || isArrayOf(value.envs, isCachedDashboardChipEnv)) &&
    isOptionalObjectArray(value.titleVariantChips, isCachedDashboardChip)
}

function isCachedDashboardCluster(value: unknown): boolean {
  return isObject(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    typeof value.isPR === 'boolean' &&
    isFiniteNumber(value.count) &&
    isStringArray(value.closableUrls) &&
    isOptionalDashboardTitleSuppressions(value.suppressedTitleParts) &&
    isOptionalTitleSuppressionToneScope(value.titleSuppressionToneScope) &&
    isOptionalTitleSuppressionToneRecord(value.suppressedTitleToneByText) &&
    isArrayOf(value.visibleChips, isCachedDashboardChip) &&
    isArrayOf(value.hiddenChips, isCachedDashboardChip) &&
    isFiniteNumber(value.hiddenCount) &&
    isOptionalBoolean(value.isPinned)
}

function isCachedDashboardWebsitePathSection(value: unknown): boolean {
  return isObject(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.sectionCount) &&
    isStringArray(value.sectionClosableUrls) &&
    typeof value.hasFlat === 'boolean' &&
    isArrayOf(value.flatVisibleChips, isCachedDashboardChip) &&
    isArrayOf(value.flatHiddenChips, isCachedDashboardChip) &&
    isFiniteNumber(value.flatHiddenCount) &&
    isOptionalDashboardTitleSuppressions(value.suppressedTitleParts) &&
    isOptionalTitleSuppressionToneScope(value.titleSuppressionToneScope) &&
    isOptionalTitleSuppressionToneRecord(value.suppressedTitleToneByText) &&
    isArrayOf(value.clusters, isCachedDashboardCluster) &&
    isOptionalBoolean(value.isPinned)
}

function isCachedDashboardSection(value: unknown): boolean {
  return isObject(value) &&
    typeof value.key === 'string' &&
    isFiniteNumber(value.sectionCount) &&
    isStringArray(value.sectionClosableUrls) &&
    typeof value.showHeader === 'boolean' &&
    typeof value.isShared === 'boolean' &&
    isOptionalBoolean(value.isPort) &&
    typeof value.hasFlat === 'boolean' &&
    isArrayOf(value.flatVisibleChips, isCachedDashboardChip) &&
    isArrayOf(value.flatHiddenChips, isCachedDashboardChip) &&
    isFiniteNumber(value.flatHiddenCount) &&
    isOptionalDashboardTitleSuppressions(value.suppressedTitleParts) &&
    isOptionalTitleSuppressionToneScope(value.titleSuppressionToneScope) &&
    isOptionalTitleSuppressionToneRecord(value.suppressedTitleToneByText) &&
    isArrayOf(value.clusters, isCachedDashboardCluster) &&
    isArrayOf(value.websitePathSections, isCachedDashboardWebsitePathSection) &&
    isOptionalBoolean(value.isPinned)
}

function isCachedMutationTarget(value: unknown): boolean {
  return isObject(value) && Number.isInteger(value.tabId) && typeof value.tabUrl === 'string'
}

function isOptionalMutationTargetsByText(value: unknown): boolean {
  return value === undefined || isRecordOf(value, (targets) => isArrayOf(targets, isCachedMutationTarget))
}

function isCachedDashboardCard(value: unknown): boolean {
  return isObject(value) &&
    typeof value.stableId === 'string' &&
    typeof value.isHidden === 'boolean' &&
    (value.displayMode === 'normal' || value.displayMode === 'unmatched') &&
    typeof value.filtering === 'boolean' &&
    isOptionalFiniteNumber(value.tabCount) &&
    isOptionalFiniteNumber(value.totalTabCount) &&
    isOptionalString(value.tabCountLabel) &&
    isOptionalString(value.tabCountTitle) &&
    isOptionalFiniteNumber(value.closableCount) &&
    isOptionalString(value.closableCountLabel) &&
    isOptionalFiniteNumber(value.suspendableCount) &&
    isOptionalString(value.suspendableCountLabel) &&
    isOptionalFiniteNumber(value.closableSuspendedCount) &&
    isOptionalString(value.closableSuspendedCountLabel) &&
    isOptionalStringArray(value.closableDupeUrls) &&
    isOptionalFiniteNumber(value.closableExtras) &&
    isOptionalString(value.singleSubdomainKey) &&
    isOptionalBoolean(value.singleSubdomainIsPort) &&
    isOptionalString(value.displayName) &&
    isOptionalDashboardTitleSuppressions(value.suppressedTitleParts) &&
    isOptionalDashboardTitleSuppressions(value.allSuppressedTitleParts) &&
    isOptionalMutationTargetsByText(value.suppressionCloseTargetsByText) &&
    isOptionalMutationTargetsByText(value.suppressionSuspendTargetsByText) &&
    isOptionalTitleSuppressionToneScope(value.cardSuppressionToneScope) &&
    isArrayOf(value.sections, isCachedDashboardSection)
}

function isCachedDashboardStats(value: unknown): boolean {
  return isObject(value) &&
    isFiniteNumber(value.totalTabs) &&
    isFiniteNumber(value.activeTabs) &&
    isFiniteNumber(value.visibleTabs) &&
    isFiniteNumber(value.totalWindows) &&
    isFiniteNumber(value.visibleWindows) &&
    isFiniteNumber(value.totalDomains) &&
    isFiniteNumber(value.visibleDomains) &&
    isFiniteNumber(value.dedupCount) &&
    isFiniteNumber(value.filteredCloseCount) &&
    typeof value.hasCards === 'boolean' &&
    typeof value.filtering === 'boolean'
}

function isCachedDashboardStartupSnapshot(value: unknown): value is CachedDashboardStartupSnapshot {
  return isObject(value) &&
    typeof value.savedAt === 'number' &&
    isOptionalString(value.contentFingerprint) &&
    isDashboardStartupSnapshot(value.snapshot)
}

function cachedStartupViewModel(value: unknown): DashboardStartupViewModel | undefined {
  if (!isObject(value) || !isObject(value.viewModel)) return undefined
  const pinnedDomains = stringArray(value.pinnedDomains)
  const pinnedPageChipIds = stringArray(value.pinnedPageChipIds)
  const pinnedSectionIds = stringArray(value.pinnedSectionIds)
  if (!pinnedDomains || !pinnedPageChipIds || !pinnedSectionIds) return undefined
  const viewModel = value.viewModel as Partial<DashboardViewModel>
  const isCardEntry = (entry: unknown) => isObject(entry) &&
    isCachedDomainGroup(entry.group) &&
    isCachedDashboardCard(entry.vm)
  if (
    viewModel.source !== 'tabs' ||
    !isCachedDashboardStats(viewModel.stats) ||
    !Array.isArray(viewModel.matchedCards) || !viewModel.matchedCards.every(isCardEntry) ||
    !Array.isArray(viewModel.unmatchedCards) || !viewModel.unmatchedCards.every(isCardEntry) ||
    typeof viewModel.showOtherTabs !== 'boolean' ||
    !isStringArray(viewModel.globalDedupeUrls) ||
    !isStringArray(viewModel.filteredCloseUrls) ||
    !Array.isArray(viewModel.filteredCloseTargets) || !viewModel.filteredCloseTargets.every(isCachedMutationTarget)
  ) return undefined
  const normalizeCardId = (entry: DashboardViewModel['matchedCards'][number]) => ({
    ...entry,
    vm: {
      ...entry.vm,
      // Stable IDs are a derived identity, not persisted product state. Repair
      // warm caches written before the collision-safe ID encoding changed.
      stableId: domainGroupCardId(entry.group)
    }
  })
  return {
    pinnedDomains,
    pinnedPageChipIds,
    pinnedSectionIds,
    viewModel: {
      ...(viewModel as DashboardViewModel),
      matchedCards: (viewModel.matchedCards as DashboardViewModel['matchedCards']).map(normalizeCardId),
      unmatchedCards: (viewModel.unmatchedCards as DashboardViewModel['unmatchedCards']).map(normalizeCardId)
    }
  }
}

export function applyPinnedDomainsToDashboardGroups(
  groups: readonly DomainGroup[],
  pinnedDomains: readonly string[]
): DomainGroup[] {
  const originalOrder = new Map(groups.map((group, index) => [group.domain, index]))
  const pinnedOrder = new Map(
    normalizePinnedDomains(pinnedDomains).map((domain, index) => [domain, index])
  )
  return groups
    .map((group) => {
      const pinned = isPinnableDomain(group.domain) && pinnedOrder.has(group.domain)
      return group.pinned === pinned ? group : { ...group, pinned }
    })
    .sort((left, right) => {
      if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
      if (left.pinned && right.pinned) {
        return (pinnedOrder.get(left.domain) ?? 0) - (pinnedOrder.get(right.domain) ?? 0)
      }
      return (originalOrder.get(left.domain) ?? 0) - (originalOrder.get(right.domain) ?? 0)
    })
}

function applyPinnedDomainsToCachedDashboard(
  dashboard: DashboardData,
  pinnedDomains: readonly string[]
): DashboardData {
  return {
    ...dashboard,
    domainGroups: applyPinnedDomainsToDashboardGroups(dashboard.domainGroups, pinnedDomains),
    ...(Array.isArray(dashboard.bookmarkDomainGroups)
      ? { bookmarkDomainGroups: applyPinnedDomainsToDashboardGroups(dashboard.bookmarkDomainGroups, pinnedDomains) }
      : {}),
    ...(Array.isArray(dashboard.historyDomainGroups)
      ? { historyDomainGroups: applyPinnedDomainsToDashboardGroups(dashboard.historyDomainGroups, pinnedDomains) }
      : {})
  }
}

function filterCachedWorkingSetToOpenDashboardTabs(workingSet: WorkingSetSnapshot, dashboard: DashboardData): WorkingSetSnapshot {
  const openKeys = new Set(
    dashboard.realTabs
      .filter((tab) => !isClosedSavedDashboardTab(tab))
      .map((tab) => pageIdentityForWorkingSet(tab?.url || tab?.rawUrl || ''))
      .filter(Boolean)
  )
  return {
    ...workingSet,
    items: workingSet.items.filter((item) => {
      const key = pageIdentityForWorkingSet(item.key) || pageIdentityForWorkingSet(item.tabUrl)
      return !!key && openKeys.has(key)
    })
  }
}

type StartupSnapshotCacheRead =
  | { ok: true; cached: CachedDashboardStartupSnapshot | null }
  | { ok: false; cached: null }

async function readStartupSnapshotCacheForMutation(storage: chrome.storage.StorageArea | null): Promise<StartupSnapshotCacheRead> {
  if (!storage) return { ok: true, cached: null }
  try {
    const stored = await storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    return { ok: true, cached: isCachedDashboardStartupSnapshot(cached) ? cached : null }
  } catch {
    // A failed read makes the generation of the existing cache unknown. Do not risk replacing
    // a newer value whose comparison could not be performed.
    return { ok: false, cached: null }
  }
}

function cachedStartupWorkingSetForSave(cached: CachedDashboardStartupSnapshot | null, now: number): { workingSet: WorkingSetSnapshot; savedAt: number } | null {
  if (!cached) return null
  const savedAt = typeof cached.workingSetSavedAt === 'number' ? cached.workingSetSavedAt : cached.savedAt
  if (now - savedAt > DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS) return null
  return {
    workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet),
    savedAt
  }
}

function cachedCaptureStartedAt(cached: CachedDashboardStartupSnapshot | null): number | null {
  if (!cached) return null
  return typeof cached.captureStartedAt === 'number' && Number.isFinite(cached.captureStartedAt)
    ? cached.captureStartedAt
    : cached.savedAt
}

async function withStartupSnapshotCacheMutationLock<T>(mutation: () => Promise<T>): Promise<T> {
  const previousMutation = startupSnapshotCacheMutationQueue.catch(() => {})
  const nextMutation = previousMutation.then(() => (
    navigator.locks.request(DASHBOARD_STARTUP_SNAPSHOT_CACHE_WRITE_LOCK, mutation)
  ))
  startupSnapshotCacheMutationQueue = nextMutation.then(() => undefined, () => undefined)
  return nextMutation
}

type HydratedCachedDashboardStartup = {
  cached: CachedDashboardStartupSnapshot
  startup: CachedDashboardStartup
}

type CachedDashboardStartupStorageRead = {
  ok: boolean
  startup: HydratedCachedDashboardStartup | null
  liveLocalState: DashboardLocalState | null
}

async function readCachedDashboardStartup(
  storage: chrome.storage.StorageArea | null,
  maxAgeMs: number | null,
  now: number,
  includeLocalStateKeys = false
): Promise<CachedDashboardStartupStorageRead> {
  if (!storage) return { ok: true, startup: null, liveLocalState: null }
  try {
    const stored = await storage.get(includeLocalStateKeys
      ? [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, ...DASHBOARD_LOCAL_STORAGE_KEYS]
      : DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const liveLocalState = includeLocalStateKeys
      ? validDashboardLocalStateFromStorage(stored)
      : null
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    if (!isCachedDashboardStartupSnapshot(cached)) return { ok: true, startup: null, liveLocalState }
    if (maxAgeMs != null && now - cached.savedAt > maxAgeMs) return { ok: true, startup: null, liveLocalState }
    const { startupViewModel: rawStartupViewModel, ...snapshot } = cached.snapshot
    const cachedLocalState = cachedDashboardLocalState(cached.localState)
    const startupViewModel = cachedStartupViewModel(rawStartupViewModel)
    const dashboard = snapshot.dashboard
    const workingSet = filterCachedWorkingSetToOpenDashboardTabs(
      normalizeWorkingSetSnapshot(snapshot.workingSet),
      dashboard
    )
    return {
      ok: true,
      startup: {
        cached,
        startup: {
          snapshot: {
            ...snapshot,
            dashboard,
            tabHistory: normalizeTabHistorySnapshot(snapshot.tabHistory),
            workingSet,
            ...(startupViewModel ? { startupViewModel } : {})
          },
          localState: cachedLocalState
        },
      },
      liveLocalState
    }
  } catch {
    return { ok: false, startup: null, liveLocalState: null }
  }
}

function applyLiveDashboardLocalState(
  hydrated: HydratedCachedDashboardStartup,
  liveLocalState: DashboardLocalState | null
): CachedDashboardStartup {
  if (!liveLocalState) return hydrated.startup

  const { startupViewModel, ...snapshot } = hydrated.startup.snapshot
  const matchingStartupViewModel = startupViewModel && sameDashboardLocalState({
    loaded: true,
    pinnedDomains: [...startupViewModel.pinnedDomains],
    pinnedSectionIds: [...startupViewModel.pinnedSectionIds],
    pinnedPageChipIds: [...startupViewModel.pinnedPageChipIds]
  }, liveLocalState)
    ? startupViewModel
    : undefined
  const dashboard = applyPinnedDomainsToCachedDashboard(snapshot.dashboard, liveLocalState.pinnedDomains)
  return {
    snapshot: {
      ...snapshot,
      dashboard,
      ...(matchingStartupViewModel ? { startupViewModel: matchingStartupViewModel } : {})
    },
    localState: liveLocalState
  }
}

export async function loadCachedDashboardStartupResult(now = Date.now()): Promise<CachedDashboardStartupLoadResult> {
  // Read and validate both representations so an older render-ready Warm Snapshot cannot mask
  // a newer source-only Durable Checkpoint. For an equal generation, prefer whichever copy has
  // a valid derived view model, then prefer session because it is the normal render-ready tier.
  const [sessionRead, durableRead] = await Promise.all([
    readCachedDashboardStartup(startupSnapshotCacheStorage(), null, now),
    readCachedDashboardStartup(startupSnapshotDurableStorage(), DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, now, true)
  ])
  const sessionStartup = sessionRead.startup
  const durableStartup = durableRead.startup
  const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionStartup?.cached ?? null) ?? Number.NEGATIVE_INFINITY
  const durableCaptureStartedAt = cachedCaptureStartedAt(durableStartup?.cached ?? null) ?? Number.NEGATIVE_INFINITY
  const selected = !sessionStartup
    ? durableStartup
    : !durableStartup
      ? sessionStartup
      : durableCaptureStartedAt > sessionCaptureStartedAt
        ? durableStartup
        : sessionCaptureStartedAt > durableCaptureStartedAt
          ? sessionStartup
          : durableStartup.startup.snapshot.startupViewModel && !sessionStartup.startup.snapshot.startupViewModel
            ? durableStartup
            : sessionStartup
  return {
    // If either representation failed, its generation is unknown. A selected value can
    // still warm the page, but the background must retry before treating cache
    // seeding as complete or overwriting that unknown representation.
    ok: sessionRead.ok && durableRead.ok,
    value: selected ? applyLiveDashboardLocalState(selected, durableRead.liveLocalState) : null
  }
}

export async function loadCachedDashboardStartup(now = Date.now()): Promise<CachedDashboardStartup | null> {
  return (await loadCachedDashboardStartupResult(now)).value
}

async function writeStartupSnapshotCache(storage: chrome.storage.StorageArea | null, payload: CachedDashboardStartupSnapshot): Promise<boolean> {
  if (!storage) return true
  let fallbackPayload = payload
  try {
    await storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: payload })
    return true
  } catch {
    if (payload.snapshot.startupViewModel) {
      const { startupViewModel: _startupViewModel, ...snapshot } = payload.snapshot
      fallbackPayload = { ...payload, snapshot }
    }
  }
  // The compact retry handles both quota pressure from the render-ready view model and a
  // one-shot storage transport failure. If it also fails, the prior valid value stays intact.
  try {
    await storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: fallbackPayload })
    return true
  } catch {
    return false
  }
}

function compactStartupSnapshotPayload(payload: CachedDashboardStartupSnapshot): CachedDashboardStartupSnapshot {
  const { startupViewModel: _startupViewModel, ...snapshot } = payload.snapshot
  return { ...payload, snapshot }
}

function durableCheckpointDueAt(
  durable: CachedDashboardStartupSnapshot | null,
  now: number,
  intervalMs: number
): number {
  const savedAt = durable?.savedAt
  if (savedAt === undefined || !Number.isFinite(savedAt) || now < savedAt) return now
  return Math.max(now, savedAt + intervalMs)
}

function rebaseCachedWorkingSetPriority(cached: WorkingSetSnapshot, live: WorkingSetSnapshot): WorkingSetSnapshot {
  const liveItemsByKey = new Map(live.items.map((item) => [item.key, item]))
  return {
    defaultLimit: cached.defaultLimit,
    expandedLimit: cached.expandedLimit,
    items: cached.items.flatMap((cachedItem) => {
      const liveItem = liveItemsByKey.get(cachedItem.key)
      if (!liveItem) return []
      return [{
        ...liveItem,
        score: cachedItem.score
      }]
    })
  }
}

function hashDashboardStartupContent(content: string): string {
  let hashA = 1_779_033_703
  let hashB = 3_144_134_277
  let hashC = 1_013_904_242
  let hashD = 2_773_480_762
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    hashA = hashB ^ Math.imul(hashA ^ code, 597_399_067)
    hashB = hashC ^ Math.imul(hashB ^ code, 2_869_860_233)
    hashC = hashD ^ Math.imul(hashC ^ code, 951_274_213)
    hashD = hashA ^ Math.imul(hashD ^ code, 2_716_044_179)
  }
  hashA = Math.imul(hashC ^ (hashA >>> 18), 597_399_067)
  hashB = Math.imul(hashD ^ (hashB >>> 22), 2_869_860_233)
  hashC = Math.imul(hashA ^ (hashC >>> 17), 951_274_213)
  hashD = Math.imul(hashB ^ (hashD >>> 19), 2_716_044_179)
  hashA ^= hashB ^ hashC ^ hashD
  hashB ^= hashA
  hashC ^= hashA
  hashD ^= hashA
  return [hashA, hashB, hashC, hashD]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

function dashboardStartupContentFingerprint(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null
): string {
  const { startupViewModel: _startupViewModel, ...snapshotWithoutViewModel } = snapshot
  const semanticContent = JSON.stringify({
    snapshot: {
      ...snapshotWithoutViewModel,
      workingSet: {
        ...snapshot.workingSet,
        // Scores decay with wall time. Ordering and row content are visible semantics; a
        // score-only change must not create a new storage generation.
        items: snapshot.workingSet.items.map((item) => ({ ...item, score: 0 }))
      }
    },
    localState: localState?.loaded ? localState : null
  })
  return `semantic-v1:${semanticContent.length}:${hashDashboardStartupContent(semanticContent)}`
}

function cachedDashboardStartupContentFingerprint(cached: CachedDashboardStartupSnapshot): string {
  return cached.contentFingerprint ?? dashboardStartupContentFingerprint(
    {
      ...cached.snapshot,
      tabHistory: normalizeTabHistorySnapshot(cached.snapshot.tabHistory),
      workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet)
    },
    cachedDashboardLocalState(cached.localState)
  )
}

export async function saveCachedDashboardStartupSnapshot(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null,
  options: SaveCachedDashboardStartupOptions = {}
): Promise<void> {
  const now = options.now ?? Date.now()
  const requestedCaptureStartedAt = options.captureStartedAt ?? now
  const captureStartedAt = Number.isFinite(requestedCaptureStartedAt)
    ? requestedCaptureStartedAt
    : now
  const requestedDurableCheckpointIntervalMs = options.durableCheckpointIntervalMs ?? 0
  const durableCheckpointIntervalMs = Number.isFinite(requestedDurableCheckpointIntervalMs)
    ? Math.max(0, requestedDurableCheckpointIntervalMs)
    : 0

  await withStartupSnapshotCacheMutationLock(async () => {
    const sessionStorage = startupSnapshotCacheStorage()
    const durableStorage = startupSnapshotDurableStorage()
    const [sessionCacheRead, durableCacheRead] = await Promise.all([
      readStartupSnapshotCacheForMutation(sessionStorage),
      readStartupSnapshotCacheForMutation(durableStorage)
    ])
    if (!sessionCacheRead.ok || !durableCacheRead.ok) return

    const existingCaptureStartedAt = Math.max(
      cachedCaptureStartedAt(sessionCacheRead.cached) ?? Number.NEGATIVE_INFINITY,
      cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    )
    if (existingCaptureStartedAt > captureStartedAt) return

    // The freeze epoch is in-session, so preserve the previously cached Working Set priority
    // from the session copy only. Rebase those priorities onto the live rows so closed targets
    // disappear and mutable tab IDs/titles/state stay current; both copies receive that payload.
    const cachedWorkingSet = cachedStartupWorkingSetForSave(sessionCacheRead.cached, now)
    const cacheSnapshotBase = cachedWorkingSet
      ? { ...snapshot, workingSet: rebaseCachedWorkingSetPriority(cachedWorkingSet.workingSet, snapshot.workingSet) }
      : snapshot
    const contentFingerprint = dashboardStartupContentFingerprint(cacheSnapshotBase, localState)
    const sessionContentCurrent = sessionStorage === null ||
      sessionCacheRead.cached?.contentFingerprint === contentFingerprint
    const sessionRenderReady = sessionStorage === null || (
      sessionContentCurrent &&
      (options.buildStartupViewModel === undefined ||
        cachedStartupViewModel(sessionCacheRead.cached?.snapshot.startupViewModel) !== undefined)
    )
    const sessionWriteRequired = !sessionContentCurrent || !sessionRenderReady
    const durableContentCurrent = durableStorage === null || (
      durableCacheRead.cached?.contentFingerprint === contentFingerprint &&
      durableCacheRead.cached.snapshot.startupViewModel === undefined
    )
    if (!sessionWriteRequired && durableContentCurrent) return
    let startupViewModel: DashboardStartupViewModel | undefined
    if (sessionWriteRequired) {
      try {
        startupViewModel = options.buildStartupViewModel?.(cacheSnapshotBase, localState)
      } catch {}
    }
    const cacheSnapshot = {
      ...cacheSnapshotBase,
      ...(startupViewModel ? { startupViewModel } : {})
    }
    const payload: CachedDashboardStartupSnapshot = {
      savedAt: now,
      captureStartedAt,
      contentFingerprint,
      workingSetSavedAt: cachedWorkingSet?.savedAt ?? now,
      snapshot: cacheSnapshot,
      ...(localState?.loaded ? { localState } : {})
    }
    const compactPayload = compactStartupSnapshotPayload(payload)
    let sessionSourceForCheckpoint = sessionStorage === null
      ? compactPayload
      : sessionCacheRead.cached

    if (sessionWriteRequired) {
      const sessionWritten = await writeStartupSnapshotCache(sessionStorage, payload)
      if (sessionWritten) sessionSourceForCheckpoint = compactPayload
    }

    const durableMissing = durableStorage !== null && durableCacheRead.cached === null
    const durableWriteDue = !durableContentCurrent &&
      durableCheckpointDueAt(durableCacheRead.cached, now, durableCheckpointIntervalMs) <= now
    if (durableMissing || (durableWriteDue && !options.scheduleDurableCheckpoint)) {
      // Durable Checkpoints are deliberately source-only. A missing checkpoint is initialized
      // immediately; callers without an alarm scheduler retain the old synchronous behavior.
      const checkpointSource = !sessionWriteRequired && sessionSourceForCheckpoint
        ? compactStartupSnapshotPayload(sessionSourceForCheckpoint)
        : compactPayload
      await writeStartupSnapshotCache(durableStorage, { ...checkpointSource, savedAt: now })
      return
    }

    if (!options.scheduleDurableCheckpoint || !sessionSourceForCheckpoint) return
    const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionSourceForCheckpoint) ?? Number.NEGATIVE_INFINITY
    const durableCaptureStartedAt = cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    const durableContentFingerprint = durableCacheRead.cached
      ? cachedDashboardStartupContentFingerprint(durableCacheRead.cached)
      : undefined
    const checkpointNeeded = !sessionContentCurrent &&
      sessionCaptureStartedAt >= durableCaptureStartedAt && (
      cachedDashboardStartupContentFingerprint(sessionSourceForCheckpoint) !== durableContentFingerprint ||
      durableCacheRead.cached?.snapshot.startupViewModel !== undefined
    )
    if (checkpointNeeded) {
      // Scheduling while holding the cache lock prevents an alarm promotion racing with this
      // save from leaving behind a clean-state alarm. The scheduler preserves an existing alarm.
      await options.scheduleDurableCheckpoint(
        durableCheckpointDueAt(durableCacheRead.cached, now, durableCheckpointIntervalMs)
      )
    }
  })
}

export async function promoteCachedDashboardStartupSnapshot(now = Date.now()): Promise<boolean> {
  return withStartupSnapshotCacheMutationLock(async () => {
    const sessionStorage = startupSnapshotCacheStorage()
    const durableStorage = startupSnapshotDurableStorage()
    const [sessionCacheRead, durableCacheRead] = await Promise.all([
      readStartupSnapshotCacheForMutation(sessionStorage),
      readStartupSnapshotCacheForMutation(durableStorage)
    ])
    if (!sessionCacheRead.ok || !durableCacheRead.ok || !sessionCacheRead.cached) return false

    const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    const durableCaptureStartedAt = cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    if (durableCaptureStartedAt > sessionCaptureStartedAt) return true

    const compactSessionPayload = compactStartupSnapshotPayload(sessionCacheRead.cached)
    const sessionContentFingerprint = cachedDashboardStartupContentFingerprint(compactSessionPayload)
    const durableCurrent = !!durableCacheRead.cached &&
      durableCacheRead.cached.contentFingerprint === sessionContentFingerprint &&
      durableCacheRead.cached.snapshot.startupViewModel === undefined
    if (durableCurrent) return true

    return writeStartupSnapshotCache(durableStorage, {
      ...compactSessionPayload,
      savedAt: now,
      contentFingerprint: sessionContentFingerprint
    })
  })
}

export type TabsStartupSnapshotInputs = {
  dashboardTabs: DashboardTab[]
  currentWindowId: number | null
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
  savedPagesStore: SavedPagesStore
  closedTabs: readonly ClosedTabEntry[]
  pinnedDomains: string[]
  tabPreviousOrder?: Map<string, number>
}

export type TabsStartupSnapshotBuild = {
  snapshot: DashboardStartupSnapshot
  savedPageUpdates: SavedPageMetadataUpdates
}

// Build the unfiltered Tabs-source startup snapshot from already-gathered inputs. Shared by the
// page (which gathers via chrome.* fetchers / service messaging) and the service worker (which
// has the same data directly), so both produce an identical snapshot and hydration cannot shift.
// The build is pure: only page-side callers persist the returned savedPageUpdates.
export async function buildTabsDashboardStartupSnapshot(inputs: TabsStartupSnapshotInputs): Promise<TabsStartupSnapshotBuild> {
  const { dashboard, savedPageUpdates } = await buildDashboardDataFromTabs(inputs.dashboardTabs, inputs.currentWindowId, inputs.tabPreviousOrder ?? new Map(), {
    pinnedDomains: inputs.pinnedDomains,
    bookmarkPreviousOrder: new Map(),
    historyPreviousOrder: new Map(),
    includeBookmarkMatches: false,
    includeHistoryMatches: false,
    searchQuery: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    savedPagesStore: inputs.savedPagesStore
  })
  const workingSet = buildWorkingSetSnapshot({
    tabs: inputs.dashboardTabs,
    activity: inputs.workingSetActivity,
    currentWindowId: inputs.currentWindowId
  })
  return {
    snapshot: { dashboard, tabHistory: inputs.tabHistory, workingSet, closedTabs: inputs.closedTabs },
    savedPageUpdates
  }
}
