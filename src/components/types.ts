import type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardWebsitePathSectionVM,
  DashboardData,
  DashboardSource,
  DashboardSectionVM,
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot
} from '../extension/types'

export type HoverUrlSource = 'chip' | 'history' | 'working-set'
export type HoverUrlChangeHandler = (url: string, source?: HoverUrlSource, matchUrls?: readonly string[]) => void
export type LayoutChangeHandler = (options?: { unpin?: boolean; animate?: boolean }) => void
export type TogglePinnedDomainHandler = (domain: string) => void | Promise<void>
export type SnapshotChangeHandler = (snapshot: TabHistorySnapshot) => void
export type TabsChangeHandler = () => void | Promise<void>

export type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardWebsitePathSectionVM,
  DashboardData,
  DashboardSource,
  DashboardSectionVM,
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot
}
