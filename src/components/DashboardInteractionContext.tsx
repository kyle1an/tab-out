import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  createHoverStateStore,
  type HoverState,
  type HoverStateSelector,
  type HoverStateStore,
} from '../lib/hover-state.js'
import type {
  HoverUrlChangeHandler,
  LayoutChangeHandler,
  ReorderPinnedDomainHandler,
  TogglePinnedDomainHandler,
  TogglePinnedPageChipHandler,
  TogglePinnedSectionHandler,
} from './types'

export type { HoverState } from '../lib/hover-state.js'

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
  source: null,
}

const defaultDashboardActions: DashboardActions = {
  onHoverUrlChange: () => {},
  onLayoutChange: () => {},
  onTogglePinnedDomain: () => {},
  onReorderPinnedDomain: () => {},
  onTogglePinnedSection: () => {},
  onTogglePinnedPageChip: () => {},
}

const defaultHoverStateStore = createHoverStateStore()
const HoverStateContext = createContext(defaultHoverStateStore)
const DashboardActionsContext = createContext(defaultDashboardActions)

type HoverStateProviderProps = {
  children?: ReactNode
  store?: HoverStateStore
  // Static-value compatibility keeps server-rendered component tests concise.
  // The application passes `store`, so its provider identity never changes.
  value?: HoverState
}

export function HoverStateProvider({ store, value = defaultHoverState, children }: HoverStateProviderProps) {
  const valueStore = useMemo(() => createHoverStateStore(value), [value])
  return <HoverStateContext.Provider value={store ?? valueStore}>{children}</HoverStateContext.Provider>
}

export function useHoverStateSelector<Selection>(selector: HoverStateSelector<Selection>): Selection {
  const store = use(HoverStateContext)
  // The selector is part of the subscription identity: when a leaf's target
  // changes, React re-subscribes it with the new target-specific predicate.
  const subscribe = useCallback((listener: () => void) => (
    store.subscribeSelector(selector, listener)
  ), [selector, store])
  const getSnapshot = useCallback(() => selector(store.getSnapshot()), [selector, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function DashboardActionsProvider({ value, children }: { value: DashboardActions, children?: ReactNode }) {
  return <DashboardActionsContext.Provider value={value}>{children}</DashboardActionsContext.Provider>
}

export function useDashboardActions() {
  return use(DashboardActionsContext)
}
