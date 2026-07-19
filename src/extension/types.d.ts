import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression-types.js'

export type TabAudioState = 'playing' | 'muted' | null

export interface DashboardTab {
  id?: number | string
  url: string
  rawUrl: string
  suspended: boolean
  title: string
  status?: chrome.tabs.Tab['status']
  /** Internal lifecycle marker persisted in startup snapshots while an unsuspended tab loads. */
  retainedSuspendedTitle?: boolean
  favIconUrl: string
  windowId: number
  active: boolean
  pinned: boolean
  groupId: number
  isTabOut: boolean
  isApp: boolean
  audible?: boolean
  muted?: boolean
  sourceType?: 'tab' | 'bookmark' | 'history' | 'saved-page'
  saved?: boolean
  closedSaved?: boolean
  savedPageKey?: string
  index?: number
}

export interface TabSnapshot {
  url: string
  rawUrl?: string
  title: string
  pinned: boolean
  groupId: number
  windowId: number
  index?: number
}

export interface DomainGroup {
  domain: string
  tabs: DashboardTab[]
  label?: string
  pinned?: boolean
}

export type DashboardSource = 'tabs' | 'bookmarks' | 'history'

export interface PathGroupResult {
  key: string
  label: string
  category?: 'pull' | 'issue' | 'commit' | 'code' | 'other'
  alwaysCluster?: boolean
}

export interface PathGroupRule {
  hostname?: string
  hostnameEndsWith?: string
  extract(url: URL): PathGroupResult | null
}

export interface UrlCanonicalizerRule {
  hostname?: string
  hostnameEndsWith?: string
  canonicalize(url: URL): string | null
}

export interface WebsitePathSectionResult {
  key: string
  label: string
}

export interface WebsitePathSectionRule {
  hostname?: string
  hostnameEndsWith?: string
  extract(url: URL): WebsitePathSectionResult | null
}

export interface DomainGroupBuildOptions {
  previousOrder?: Map<string, number>
  pinnedDomains?: string[]
}

export type DashboardChipOrderByCard = Map<string, Map<string, number>>
export type DashboardChipPriorityMap = Map<string, number>

export type DashboardSegment = string | { placeholder: true; label?: string } | { titleSuppression: string }

export interface DashboardTitleSuppression {
  text: string
  count: number
  spansRenderedChildGroups?: boolean
}

export interface DashboardChipEnv {
  tabId?: number | string
  prefix: string
  tabUrl: string
  rawUrl: string
  sourceType?: DashboardTab['sourceType']
  saved?: boolean
  closedSaved?: boolean
  savedPageKey?: string
  title?: string
  faviconUrl?: string
  isApp?: boolean
  activeInOtherWindow?: boolean
}

export interface DashboardChipData {
  tabId?: number | string
  tabUrl: string
  rawUrl: string
  sourceType?: 'tab' | 'bookmark' | 'history' | 'saved-page'
  saved?: boolean
  closedSaved?: boolean
  /** Every open tab behind this chip is suspended (none live). */
  suspended?: boolean
  /** At least one live open tab represented by this chip is loading. */
  loading?: boolean
  savedPageKey?: string
  pagePinId?: string
  pagePinned?: boolean
  pagePinDisabled?: boolean
  leadPrefix: string
  pathGroupLabel: string
  title?: string
  displaySegments: DashboardSegment[]
  suppressedTitleParts: string[]
  pathSuffix: string
  tooltip: string
  dupeCount: number
  faviconUrl: string
  isGrouped: boolean
  groupDotColor: string | null
  isApp: boolean
  audioState?: TabAudioState
  activeInOtherWindow?: boolean
  activeChipFrame?: boolean
  isCurrentTabOut?: boolean
  chromePinned?: boolean
  iconOnly?: boolean
  envs: DashboardChipEnv[] | null
  titleVariantChips?: DashboardChipData[]
}

export interface DashboardClusterVM {
  key: string
  label: string
  isPR: boolean
  count: number
  closableUrls: string[]
  suppressedTitleParts?: DashboardTitleSuppression[]
  /** Populated by computeDomainCardViewModel's tone allocation walk. */
  titleSuppressionToneScope?: TitleSuppressionToneScope
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  isPinned?: boolean
}

export interface DashboardWebsitePathSectionVM {
  key: string
  label: string
  sectionCount: number
  sectionClosableUrls: string[]
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  suppressedTitleParts?: DashboardTitleSuppression[]
  /** Populated by computeDomainCardViewModel's tone allocation walk. */
  titleSuppressionToneScope?: TitleSuppressionToneScope
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  clusters: DashboardClusterVM[]
  isPinned?: boolean
}

export interface DashboardSectionVM {
  key: string
  sectionCount: number
  sectionClosableUrls: string[]
  showHeader: boolean
  isShared: boolean
  isPort?: boolean
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  suppressedTitleParts?: DashboardTitleSuppression[]
  /** Populated by computeDomainCardViewModel's tone allocation walk. */
  titleSuppressionToneScope?: TitleSuppressionToneScope
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  clusters: DashboardClusterVM[]
  websitePathSections: DashboardWebsitePathSectionVM[]
  isPinned?: boolean
}

export interface DashboardCardVM {
  stableId: string
  isHidden: boolean
  displayMode: 'normal' | 'unmatched'
  filtering: boolean
  tabCount?: number
  totalTabCount?: number
  tabCountLabel?: string
  tabCountTitle?: string
  closableCount?: number
  closableCountLabel?: string
  suspendableCount?: number
  suspendableCountLabel?: string
  closableDupeUrls?: string[]
  closableExtras?: number
  singleSubdomainKey?: string
  singleSubdomainIsPort?: boolean
  displayName?: string
  suppressedTitleParts?: DashboardTitleSuppression[]
  allSuppressedTitleParts?: DashboardTitleSuppression[]
  suppressionCloseUrlsByText?: Record<string, string[]>
  suppressionSuspendUrlsByText?: Record<string, string[]>
  /** Populated by computeDomainCardViewModel's tone allocation walk. */
  cardSuppressionToneScope?: TitleSuppressionToneScope
  sections?: DashboardSectionVM[]
}

export interface DashboardCardEntry {
  group: DomainGroup
  vm: DashboardCardVM
}

export interface DashboardStats {
  totalTabs: number
  activeTabs: number
  visibleTabs: number
  totalWindows: number
  visibleWindows: number
  totalDomains: number
  visibleDomains: number
  dedupCount: number
  filteredCloseCount: number
  hasCards: boolean
  filtering: boolean
}

export interface DashboardViewModel {
  source: DashboardSource
  stats: DashboardStats
  matchedCards: DashboardCardEntry[]
  unmatchedCards: DashboardCardEntry[]
  showOtherTabs: boolean
  globalDedupeUrls: string[]
  filteredCloseUrls: string[]
}

export interface DashboardData {
  realTabs: DashboardTab[]
  domainGroups: DomainGroup[]
  currentWindowId?: number | null
  bookmarkTabs?: DashboardTab[]
  bookmarkDomainGroups?: DomainGroup[]
  bookmarkSearchReady?: boolean
  historyTabs?: DashboardTab[]
  historyDomainGroups?: DomainGroup[]
  historySearchQuery?: string
  historyRange?: string
  savedKeys?: readonly string[]
}

export type WorkingSetActivityKind = 'activation' | 'navigation'

export interface WorkingSetActivityEvent {
  kind: WorkingSetActivityKind
  at: number
}

export interface WorkingSetActivityRecord {
  key: string
  url: string
  title: string
  domain: string
  lastSeenAt: number
  lastActivatedAt?: number
  lastNavigatedAt?: number
  dismissedAt?: number
  dismissedUntil?: number
  events: WorkingSetActivityEvent[]
}

export interface WorkingSetActivityStore {
  version: 1
  records: Record<string, WorkingSetActivityRecord>
}

export interface WorkingSetItem {
  key: string
  tabId: number
  windowId: number
  tabUrl: string
  rawUrl: string
  title: string
  displayUrl: string
  faviconUrl: string
  dupeCount: number
  active: boolean
  activeInOtherWindow: boolean
  loading?: boolean
  audible?: boolean
  muted?: boolean
  score: number
  /**
   * Most recent activation OR navigation timestamp for this item's URL,
   * derived as Math.max(lastActivatedAt, lastNavigatedAt) from the activity
   * record. Non-nullable because a working-set item only exists when an
   * activity record does.
   */
  lastActivatedAt: number
}

export interface WorkingSetSnapshot {
  defaultLimit: number
  expandedLimit: number
  items: WorkingSetItem[]
}

export interface BookmarkTreeNode {
  id?: string
  title?: string
  url?: string
  children?: BookmarkTreeNode[]
}

export interface TabHistoryEntry {
  index: number
  tabId: number
  windowId: number
  exists: boolean
  active: boolean
  activeInOtherWindow: boolean
  isApp: boolean
  pinned: boolean
  discarded: boolean
  suspended: boolean
  loading?: boolean
  audible?: boolean
  muted?: boolean
  /** True when the tab was opened in the background but has not been activated yet. */
  pending?: boolean
  /** Creation timestamp for a pending background tab; null for activated history entries. */
  createdAt?: number | null
  cursor: boolean
  current: boolean
  previousTarget: boolean
  nextTarget: boolean
  title: string
  url: string
  rawUrl: string
  displayUrl: string
  favIconUrl: string
  /**
   * Most recent activation OR navigation timestamp for this entry's URL,
   * derived as Math.max(lastActivatedAt, lastNavigatedAt) from the activity
   * log. Null when the URL has no activity record yet (e.g. a tab that was
   * opened but never explicitly activated while the extension was running).
   */
  lastActivatedAt: number | null
}

export interface TabHistorySnapshot {
  stackSize: number
  pendingSize?: number
  maxSize: number
  cursorIndex: number
  currentIndex: number
  previousIndex: number
  nextIndex: number
  activeTabId: number | null
  activeWindowId: number | null
  activeWasInserted: boolean
  entries: TabHistoryEntry[]
}

export {}
