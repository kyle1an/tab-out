import { Result, Schema } from 'effect'

import type { ClosedTabEntry } from './closed-tabs.js'
import { domainGroupCardId } from './domain-card-id.js'
import type { DashboardLocalState } from './dashboard-local-state.js'
import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression-types.js'
import type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardChipEnv,
  DashboardClusterVM,
  DashboardData,
  DashboardSectionVM,
  DashboardSegment,
  DashboardStats,
  DashboardTab,
  DashboardTabMutationTarget,
  DashboardTitleSuppression,
  DashboardViewModel,
  DashboardWebsitePathSectionVM,
  DomainGroup
} from './types'

export type DashboardStartupViewModel = {
  pinnedDomains: readonly string[]
  pinnedPageChipIds: readonly string[]
  pinnedSectionIds: readonly string[]
  viewModel: DashboardViewModel
}

const mutableStringArray = Schema.mutable(Schema.Array(Schema.String))
const dashboardTabId = Schema.Union([Schema.String, Schema.Finite])
const dashboardSourceType = Schema.Literals(['tab', 'bookmark', 'history', 'saved-page'])

const dashboardTabSchema = Schema.Struct({
  id: Schema.optionalKey(dashboardTabId),
  url: Schema.String,
  rawUrl: Schema.String,
  suspended: Schema.Boolean,
  title: Schema.String,
  status: Schema.optionalKey(Schema.Literals(['unloaded', 'loading', 'complete'])),
  retainedSuspendedTitle: Schema.optionalKey(Schema.Boolean),
  favIconUrl: Schema.String,
  windowId: Schema.Finite,
  active: Schema.Boolean,
  pinned: Schema.Boolean,
  groupId: Schema.Finite,
  isTabOut: Schema.Boolean,
  isApp: Schema.Boolean,
  audible: Schema.optionalKey(Schema.Boolean),
  muted: Schema.optionalKey(Schema.Boolean),
  sourceType: Schema.optionalKey(dashboardSourceType),
  saved: Schema.optionalKey(Schema.Boolean),
  closedSaved: Schema.optionalKey(Schema.Boolean),
  savedPageKey: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Finite)
}) satisfies Schema.Schema<DashboardTab>

const domainGroupSchema = Schema.Struct({
  domain: Schema.String,
  tabs: Schema.mutable(Schema.Array(dashboardTabSchema)),
  label: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DomainGroup>

const dashboardDataSchema = Schema.Struct({
  realTabs: Schema.mutable(Schema.Array(dashboardTabSchema)),
  domainGroups: Schema.mutable(Schema.Array(domainGroupSchema)),
  currentWindowId: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  bookmarkTabs: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTabSchema))),
  bookmarkDomainGroups: Schema.optionalKey(Schema.mutable(Schema.Array(domainGroupSchema))),
  bookmarkSearchReady: Schema.optionalKey(Schema.Boolean),
  historyTabs: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTabSchema))),
  historyDomainGroups: Schema.optionalKey(Schema.mutable(Schema.Array(domainGroupSchema))),
  historySearchQuery: Schema.optionalKey(Schema.String),
  historyRange: Schema.optionalKey(Schema.String),
  historySearchStatus: Schema.optionalKey(Schema.Literals(['idle', 'ready', 'error'])),
  savedKeys: Schema.optionalKey(mutableStringArray)
}) satisfies Schema.Schema<DashboardData>

const cachedClosedTabSchema = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  lastClosedAt: Schema.Number,
  tabId: Schema.optionalKey(Schema.Unknown),
  rawUrl: Schema.optionalKey(Schema.Unknown),
  displayUrl: Schema.optionalKey(Schema.Unknown),
  favIconUrl: Schema.optionalKey(Schema.Unknown)
})

type CachedClosedTab = typeof cachedClosedTabSchema.Type

function normalizeCachedClosedTab(tab: CachedClosedTab): ClosedTabEntry {
  return {
    sessionId: tab.sessionId,
    tabId: typeof tab.tabId === 'number' && Number.isFinite(tab.tabId) ? tab.tabId : -1,
    url: tab.url,
    rawUrl: typeof tab.rawUrl === 'string' ? tab.rawUrl : tab.url,
    displayUrl: typeof tab.displayUrl === 'string' ? tab.displayUrl : tab.url,
    title: tab.title,
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : '',
    lastClosedAt: tab.lastClosedAt
  }
}

const unknownRecord = Schema.Record(Schema.String, Schema.Unknown)

const cachedDashboardStartupBoundarySchema = Schema.Struct({
  savedAt: Schema.Number,
  captureStartedAt: Schema.optionalKey(Schema.Unknown),
  contentFingerprint: Schema.optionalKey(Schema.String),
  workingSetSavedAt: Schema.optionalKey(Schema.Unknown),
  snapshot: Schema.Struct({
    dashboard: dashboardDataSchema,
    tabHistory: Schema.optionalKey(Schema.NullOr(unknownRecord)),
    workingSet: Schema.optionalKey(Schema.NullOr(unknownRecord)),
    closedTabs: Schema.mutable(Schema.Array(cachedClosedTabSchema)),
    startupViewModel: Schema.optionalKey(Schema.Unknown)
  }),
  localState: Schema.optionalKey(Schema.Unknown)
})

const isCachedDashboardStartupBoundary = Schema.is(cachedDashboardStartupBoundarySchema)

export type CachedDashboardStartupBoundary = {
  savedAt: number
  captureStartedAt: unknown
  contentFingerprint?: string
  workingSetSavedAt: unknown
  snapshot: {
    dashboard: DashboardData
    tabHistory: unknown
    workingSet: unknown
    closedTabs: readonly ClosedTabEntry[]
    startupViewModel?: unknown
  }
  localState?: unknown
}

export function parseCachedDashboardStartupBoundary(value: unknown): CachedDashboardStartupBoundary | null {
  if (!isCachedDashboardStartupBoundary(value)) return null
  const boundary = value
  return {
    savedAt: boundary.savedAt,
    captureStartedAt: boundary.captureStartedAt,
    ...(boundary.contentFingerprint === undefined
      ? {}
      : { contentFingerprint: boundary.contentFingerprint }),
    workingSetSavedAt: boundary.workingSetSavedAt,
    snapshot: {
      dashboard: boundary.snapshot.dashboard,
      tabHistory: boundary.snapshot.tabHistory,
      workingSet: boundary.snapshot.workingSet,
      closedTabs: boundary.snapshot.closedTabs.map(normalizeCachedClosedTab),
      ...(boundary.snapshot.startupViewModel === undefined
        ? {}
        : { startupViewModel: boundary.snapshot.startupViewModel })
    },
    ...(boundary.localState === undefined ? {} : { localState: boundary.localState })
  }
}

const dashboardLocalStateSchema = Schema.Struct({
  loaded: Schema.Literals([true]),
  pinnedDomains: mutableStringArray,
  pinnedSectionIds: mutableStringArray,
  pinnedPageChipIds: mutableStringArray
}) satisfies Schema.Schema<DashboardLocalState>

const decodeDashboardLocalState = Schema.decodeUnknownResult(dashboardLocalStateSchema)

export function parseCachedDashboardLocalState(value: unknown): DashboardLocalState | null {
  const result = decodeDashboardLocalState(value)
  return Result.isFailure(result) ? null : result.success
}

const dashboardTitleSuppressionSchema = Schema.Struct({
  text: Schema.String,
  count: Schema.Finite,
  spansRenderedChildGroups: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DashboardTitleSuppression>

const titleSuppressionToneSchema = Schema.Literals([
  '',
  'amber',
  'teal',
  'sky',
  'rose'
]) satisfies Schema.Schema<TitleSuppressionTone | ''>

const titleSuppressionToneScopeSchema = Schema.Struct({
  useSuppressionTokenTones: Schema.Boolean,
  suppressedTitleToneIndexByText: Schema.Record(Schema.String, Schema.Finite),
  suppressedTitleToneByText: Schema.Record(Schema.String, titleSuppressionToneSchema),
  usedToneCount: Schema.Finite
}) satisfies Schema.Schema<TitleSuppressionToneScope>

const dashboardSegmentSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    placeholder: Schema.Literals([true]),
    label: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({ titleSuppression: Schema.String })
]) satisfies Schema.Schema<DashboardSegment>

const dashboardChipEnvSchema = Schema.Struct({
  tabId: Schema.optionalKey(dashboardTabId),
  prefix: Schema.String,
  tabUrl: Schema.String,
  rawUrl: Schema.String,
  sourceType: Schema.optionalKey(dashboardSourceType),
  saved: Schema.optionalKey(Schema.Boolean),
  closedSaved: Schema.optionalKey(Schema.Boolean),
  savedPageKey: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  faviconUrl: Schema.optionalKey(Schema.String),
  isApp: Schema.optionalKey(Schema.Boolean),
  activeInOtherWindow: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DashboardChipEnv>

const dashboardChipSchema = Schema.Struct({
  tabId: Schema.optionalKey(dashboardTabId),
  tabUrl: Schema.String,
  rawUrl: Schema.String,
  sourceType: Schema.optionalKey(dashboardSourceType),
  saved: Schema.optionalKey(Schema.Boolean),
  closedSaved: Schema.optionalKey(Schema.Boolean),
  suspended: Schema.optionalKey(Schema.Boolean),
  loading: Schema.optionalKey(Schema.Boolean),
  savedPageKey: Schema.optionalKey(Schema.String),
  pagePinId: Schema.optionalKey(Schema.String),
  pagePinned: Schema.optionalKey(Schema.Boolean),
  pagePinDisabled: Schema.optionalKey(Schema.Boolean),
  leadPrefix: Schema.String,
  pathGroupLabel: Schema.String,
  title: Schema.optionalKey(Schema.String),
  displaySegments: Schema.mutable(Schema.Array(dashboardSegmentSchema)),
  suppressedTitleParts: mutableStringArray,
  pathSuffix: Schema.String,
  tooltip: Schema.String,
  dupeCount: Schema.Finite,
  faviconUrl: Schema.String,
  isGrouped: Schema.Boolean,
  groupDotColor: Schema.NullOr(Schema.String),
  isApp: Schema.Boolean,
  audioState: Schema.optionalKey(Schema.NullOr(Schema.Literals(['playing', 'muted']))),
  activeInOtherWindow: Schema.optionalKey(Schema.Boolean),
  activeChipFrame: Schema.optionalKey(Schema.Boolean),
  isCurrentTabOut: Schema.optionalKey(Schema.Boolean),
  chromePinned: Schema.optionalKey(Schema.Boolean),
  chromeGroupId: Schema.optionalKey(Schema.Finite),
  iconOnly: Schema.optionalKey(Schema.Boolean),
  envs: Schema.NullOr(Schema.mutable(Schema.Array(dashboardChipEnvSchema))),
  titleVariantChips: Schema.optionalKey(Schema.mutable(Schema.Array(
    Schema.suspend((): Schema.Codec<DashboardChipData> => dashboardChipSchema)
  )))
}) satisfies Schema.Schema<DashboardChipData>

const dashboardClusterSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  isPR: Schema.Boolean,
  count: Schema.Finite,
  closableUrls: mutableStringArray,
  suppressedTitleParts: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTitleSuppressionSchema))),
  titleSuppressionToneScope: Schema.optionalKey(titleSuppressionToneScopeSchema),
  suppressedTitleToneByText: Schema.optionalKey(Schema.Record(Schema.String, titleSuppressionToneSchema)),
  visibleChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  hiddenChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  hiddenCount: Schema.Finite,
  isPinned: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DashboardClusterVM>

const dashboardWebsitePathSectionSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  sectionCount: Schema.Finite,
  sectionClosableUrls: mutableStringArray,
  hasFlat: Schema.Boolean,
  flatVisibleChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  flatHiddenChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  flatHiddenCount: Schema.Finite,
  suppressedTitleParts: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTitleSuppressionSchema))),
  titleSuppressionToneScope: Schema.optionalKey(titleSuppressionToneScopeSchema),
  suppressedTitleToneByText: Schema.optionalKey(Schema.Record(Schema.String, titleSuppressionToneSchema)),
  clusters: Schema.mutable(Schema.Array(dashboardClusterSchema)),
  isPinned: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DashboardWebsitePathSectionVM>

const dashboardSectionSchema = Schema.Struct({
  key: Schema.String,
  sectionCount: Schema.Finite,
  sectionClosableUrls: mutableStringArray,
  showHeader: Schema.Boolean,
  isShared: Schema.Boolean,
  isPort: Schema.optionalKey(Schema.Boolean),
  hasFlat: Schema.Boolean,
  flatVisibleChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  flatHiddenChips: Schema.mutable(Schema.Array(dashboardChipSchema)),
  flatHiddenCount: Schema.Finite,
  suppressedTitleParts: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTitleSuppressionSchema))),
  titleSuppressionToneScope: Schema.optionalKey(titleSuppressionToneScopeSchema),
  suppressedTitleToneByText: Schema.optionalKey(Schema.Record(Schema.String, titleSuppressionToneSchema)),
  clusters: Schema.mutable(Schema.Array(dashboardClusterSchema)),
  websitePathSections: Schema.mutable(Schema.Array(dashboardWebsitePathSectionSchema)),
  isPinned: Schema.optionalKey(Schema.Boolean)
}) satisfies Schema.Schema<DashboardSectionVM>

const dashboardMutationTargetSchema = Schema.Struct({
  tabId: Schema.Int,
  tabUrl: Schema.String
}) satisfies Schema.Schema<DashboardTabMutationTarget>

const mutationTargetsByTextSchema = Schema.Record(
  Schema.String,
  Schema.mutable(Schema.Array(dashboardMutationTargetSchema))
)

const dashboardCardSchema = Schema.Struct({
  stableId: Schema.String,
  isHidden: Schema.Boolean,
  displayMode: Schema.Literals(['normal', 'unmatched']),
  filtering: Schema.Boolean,
  tabCount: Schema.optionalKey(Schema.Finite),
  totalTabCount: Schema.optionalKey(Schema.Finite),
  tabCountLabel: Schema.optionalKey(Schema.String),
  tabCountTitle: Schema.optionalKey(Schema.String),
  closableCount: Schema.optionalKey(Schema.Finite),
  closableCountLabel: Schema.optionalKey(Schema.String),
  suspendableCount: Schema.optionalKey(Schema.Finite),
  suspendableCountLabel: Schema.optionalKey(Schema.String),
  closableSuspendedCount: Schema.optionalKey(Schema.Finite),
  closableSuspendedCountLabel: Schema.optionalKey(Schema.String),
  closableDupeUrls: Schema.optionalKey(mutableStringArray),
  closableExtras: Schema.optionalKey(Schema.Finite),
  singleSubdomainKey: Schema.optionalKey(Schema.String),
  singleSubdomainIsPort: Schema.optionalKey(Schema.Boolean),
  displayName: Schema.optionalKey(Schema.String),
  suppressedTitleParts: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTitleSuppressionSchema))),
  allSuppressedTitleParts: Schema.optionalKey(Schema.mutable(Schema.Array(dashboardTitleSuppressionSchema))),
  suppressionCloseTargetsByText: Schema.optionalKey(mutationTargetsByTextSchema),
  suppressionSuspendTargetsByText: Schema.optionalKey(mutationTargetsByTextSchema),
  cardSuppressionToneScope: Schema.optionalKey(titleSuppressionToneScopeSchema),
  sections: Schema.mutable(Schema.Array(dashboardSectionSchema))
}) satisfies Schema.Schema<DashboardCardVM>

const dashboardCardEntrySchema = Schema.Struct({
  group: domainGroupSchema,
  vm: dashboardCardSchema
}) satisfies Schema.Schema<DashboardCardEntry>

const dashboardStatsSchema = Schema.Struct({
  totalTabs: Schema.Finite,
  activeTabs: Schema.Finite,
  visibleTabs: Schema.Finite,
  totalWindows: Schema.Finite,
  visibleWindows: Schema.Finite,
  totalDomains: Schema.Finite,
  visibleDomains: Schema.Finite,
  dedupCount: Schema.Finite,
  filteredCloseCount: Schema.Finite,
  hasCards: Schema.Boolean,
  filtering: Schema.Boolean
}) satisfies Schema.Schema<DashboardStats>

const dashboardViewModelSchema = Schema.Struct({
  source: Schema.Literals(['tabs']),
  stats: dashboardStatsSchema,
  matchedCards: Schema.mutable(Schema.Array(dashboardCardEntrySchema)),
  unmatchedCards: Schema.mutable(Schema.Array(dashboardCardEntrySchema)),
  showOtherTabs: Schema.Boolean,
  globalDedupeUrls: mutableStringArray,
  filteredCloseUrls: mutableStringArray,
  filteredCloseTargets: Schema.mutable(Schema.Array(dashboardMutationTargetSchema))
}) satisfies Schema.Schema<DashboardViewModel>

const dashboardStartupViewModelSchema = Schema.Struct({
  pinnedDomains: mutableStringArray,
  pinnedPageChipIds: mutableStringArray,
  pinnedSectionIds: mutableStringArray,
  viewModel: dashboardViewModelSchema
}) satisfies Schema.Schema<DashboardStartupViewModel>

const decodeDashboardStartupViewModel = Schema.decodeUnknownResult(dashboardStartupViewModelSchema)

function repairCachedDashboardCardId(entry: DashboardCardEntry): DashboardCardEntry {
  return {
    ...entry,
    vm: {
      ...entry.vm,
      // Stable IDs are derived identity, not persisted product state. Repair
      // caches written before the collision-safe encoding changed.
      stableId: domainGroupCardId(entry.group)
    }
  }
}

export function parseCachedDashboardStartupViewModel(value: unknown): DashboardStartupViewModel | undefined {
  const result = decodeDashboardStartupViewModel(value)
  if (Result.isFailure(result)) return undefined
  return {
    ...result.success,
    viewModel: {
      ...result.success.viewModel,
      matchedCards: result.success.viewModel.matchedCards.map(repairCachedDashboardCardId),
      unmatchedCards: result.success.viewModel.unmatchedCards.map(repairCachedDashboardCardId)
    }
  }
}
