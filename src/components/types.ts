import type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardWebsitePathSectionVM,
  DashboardData,
  DashboardSource,
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot
} from '../extension/types'
import type { PinnedDomainReorderPlacement } from '../extension/domain-pins.js'

export type HoverUrlSource = 'chip' | 'history' | 'working-set'
export type HoverUrlChangeHandler = (url: string, source?: HoverUrlSource, matchUrls?: readonly string[], tabId?: number) => void | Promise<void>
export type LayoutChangeHandler = (options?: { unpin?: boolean; animate?: boolean }) => void
export type TogglePinnedDomainHandler = (domain: string) => void | Promise<void>
export type ReorderPinnedDomainHandler = (domain: string, placement: PinnedDomainReorderPlacement) => void | Promise<void>
export type TogglePinnedSectionHandler = (sectionId: string) => void | Promise<void>
export type TogglePinnedPageChipHandler = (pageChipPinId: string) => void | Promise<void>
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
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot
}
