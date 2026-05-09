export interface DashboardTab {
  id?: number | string
  url: string
  rawUrl: string
  suspended: boolean
  title: string
  favIconUrl: string
  windowId: number
  active: boolean
  pinned: boolean
  groupId: number
  isTabOut: boolean
  isApp: boolean
  sourceType?: 'tab' | 'bookmark' | 'history'
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

export interface CustomGroupRule {
  hostname?: string
  hostnameEndsWith?: string
  pathPrefix?: string
  groupKey: string
  groupLabel: string
}

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

export interface DomainGroupBuildOptions {
  previousOrder?: Map<string, number>
  customGroups?: CustomGroupRule[]
  pinnedDomains?: string[]
}

export type DashboardSegment = string | { placeholder: true } | { titleSuppression: string }

export interface DashboardTitleSuppression {
  text: string
  count: number
}

export interface DashboardChipEnv {
  prefix: string
  tabUrl: string
  rawUrl: string
  activeInOtherWindow?: boolean
}

export interface DashboardChipData {
  tabUrl: string
  rawUrl: string
  sourceType?: 'tab' | 'bookmark' | 'history'
  leadPrefix: string
  pathGroupLabel: string
  displaySegments: DashboardSegment[]
  suppressedTitleParts: string[]
  pathSuffix: string
  tooltip: string
  dupeCount: number
  faviconUrl: string
  isGrouped: boolean
  groupDotColor: string | null
  isApp: boolean
  activeInOtherWindow?: boolean
  iconOnly?: boolean
  envs: DashboardChipEnv[] | null
}

export interface DashboardClusterVM {
  key: string
  label: string
  isPR: boolean
  count: number
  closableUrls: string[]
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
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
  clusters: DashboardClusterVM[]
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
  closableDupeUrls?: string[]
  closableExtras?: number
  singleSubdomainKey?: string
  singleSubdomainIsPort?: boolean
  displayName?: string
  suppressedTitleParts?: DashboardTitleSuppression[]
  sections?: DashboardSectionVM[]
}

export interface DashboardCardEntry {
  group: DomainGroup
  vm: DashboardCardVM
}

export interface DashboardStats {
  totalTabs: number
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
  pinned: boolean
  discarded: boolean
  cursor: boolean
  current: boolean
  previousTarget: boolean
  nextTarget: boolean
  title: string
  url: string
  displayUrl: string
  favIconUrl: string
}

export interface TabHistorySnapshot {
  stackSize: number
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

declare global {
  interface Window {
    LOCAL_CUSTOM_GROUPS?: CustomGroupRule[]
    LOCAL_PATH_GROUPERS?: PathGroupRule[]
  }
}

export {}
