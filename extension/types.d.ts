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
  sourceType?: 'tab' | 'bookmark'
  index?: number
}

export interface TabSnapshot {
  url: string
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
}

export interface LandingPagePattern {
  hostname?: string
  hostnameEndsWith?: string
  pathPrefix?: string
  pathExact?: string[]
  test?: (pathname: string, url: string) => boolean
}

export interface CustomGroupRule {
  hostname?: string
  hostnameEndsWith?: string
  pathPrefix?: string
  groupKey: string
  groupLabel: string
}

export interface DomainGroupBuildOptions {
  previousOrder?: Map<string, number>
  landingPagePatterns?: LandingPagePattern[]
  customGroups?: CustomGroupRule[]
}

export type DashboardSegment = string | { placeholder: true }

export interface DashboardChipEnv {
  prefix: string
  tabUrl: string
  rawUrl: string
}

export interface DashboardChipData {
  tabUrl: string
  rawUrl: string
  sourceType?: 'tab' | 'bookmark'
  leadPrefix: string
  pathGroupLabel: string
  displaySegments: DashboardSegment[]
  titleStripped: boolean
  pathSuffix: string
  tooltip: string
  dupeCount: number
  faviconUrl: string
  isGrouped: boolean
  groupDotColor: string | null
  isApp: boolean
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
  isLanding?: boolean
  tabCount?: number
  closableCount?: number
  closableCountLabel?: string
  closableDupeUrls?: string[]
  closableExtras?: number
  dupeUrlsEncoded?: string
  singleSubdomainKey?: string
  singleSubdomainIsPort?: boolean
  displayName?: string
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
  source: 'tabs' | 'bookmarks'
  stats: DashboardStats
  matchedCards: DashboardCardEntry[]
  unmatchedCards: DashboardCardEntry[]
  showOtherTabs: boolean
  globalDedupeUrls: string[]
  filteredCloseUrls: string[]
}

declare global {
  interface Window {
    LOCAL_LANDING_PAGE_PATTERNS?: LandingPagePattern[]
    LOCAL_CUSTOM_GROUPS?: CustomGroupRule[]
    LOCAL_PATH_GROUPERS?: any[]
  }

  const chrome: any
}

export {}
