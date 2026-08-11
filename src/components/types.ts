import type {
  DashboardCardEntry,
  DashboardCardVM,
  DashboardChipData,
  DashboardClusterVM,
  DashboardWebsitePathSectionVM,
  DashboardSource,
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot,
} from '../extension/types'
import type { PinnedDomainReorderPlacement } from '../extension/domain-pins.js'

export type { HoverUrlChangeHandler, HoverUrlSource } from '../lib/hover-state.js'
export type LayoutChangeHandler = (options?: { unpin?: boolean, animate?: boolean }) => void
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
  DashboardSource,
  DashboardStats,
  DashboardTitleSuppression,
  DomainGroup,
  TabHistorySnapshot,
}
