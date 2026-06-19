import { createContext, use, type ReactNode } from 'react'
import type {
  HoverUrlChangeHandler,
  HoverUrlSource,
  LayoutChangeHandler,
  ReorderPinnedDomainHandler,
  TogglePinnedDomainHandler,
  TogglePinnedPageChipHandler,
  TogglePinnedSectionHandler
} from './types'

// Volatile hover state shared across the dashboard. Changes on every hover, so it
// lives in its own context: only the leaves that actually read it (page chips,
// overflow expanders) re-render when the hovered URL changes — not the cards above them.
export type HoverState = {
  url: string
  urls: readonly string[]
  source: HoverUrlSource | null
}

// Stable interaction handlers. These never change identity across renders, so consumers
// that only need to dispatch (e.g. DomainCard's pin buttons) never re-render from this context.
export type DashboardActions = {
  onHoverUrlChange: HoverUrlChangeHandler
  onLayoutChange: LayoutChangeHandler
  onTogglePinnedDomain: TogglePinnedDomainHandler
  onReorderPinnedDomain: ReorderPinnedDomainHandler
  onTogglePinnedSection: TogglePinnedSectionHandler
  onTogglePinnedPageChip: TogglePinnedPageChipHandler
}

const defaultHoverState: HoverState = {
  url: '',
  urls: [],
  source: null
}

const defaultDashboardActions: DashboardActions = {
  onHoverUrlChange: () => {},
  onLayoutChange: () => {},
  onTogglePinnedDomain: () => {},
  onReorderPinnedDomain: () => {},
  onTogglePinnedSection: () => {},
  onTogglePinnedPageChip: () => {}
}

const HoverStateContext = createContext(defaultHoverState)
const DashboardActionsContext = createContext(defaultDashboardActions)

export function HoverStateProvider({ value, children }: { value: HoverState; children?: ReactNode }) {
  return <HoverStateContext.Provider value={value}>{children}</HoverStateContext.Provider>
}

export function useHoverState() {
  return use(HoverStateContext)
}

export function DashboardActionsProvider({ value, children }: { value: DashboardActions; children?: ReactNode }) {
  return <DashboardActionsContext.Provider value={value}>{children}</DashboardActionsContext.Provider>
}

export function useDashboardActions() {
  return use(DashboardActionsContext)
}
