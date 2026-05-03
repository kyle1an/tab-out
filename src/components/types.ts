import type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardData,
  DashboardSectionVM,
  DashboardStats,
  DomainGroup,
  TabHistorySnapshot
} from '../extension/types'

export type DashboardSource = 'tabs' | 'bookmarks' | 'history'
export type HoverUrlChangeHandler = (url: string) => void
export type LayoutChangeHandler = (options?: { unpin?: boolean; animate?: boolean }) => void
export type TogglePinnedDomainHandler = (domain: string) => void | Promise<void>
export type SnapshotChangeHandler = (snapshot: TabHistorySnapshot) => void
export type TabsChangeHandler = () => void | Promise<void>

export type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardData,
  DashboardSectionVM,
  DashboardStats,
  DomainGroup,
  TabHistorySnapshot
}
