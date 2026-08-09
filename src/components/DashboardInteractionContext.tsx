import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type {
  HoverUrlChangeHandler,
  HoverUrlSource,
  LayoutChangeHandler,
  ReorderPinnedDomainHandler,
  TogglePinnedDomainHandler,
  TogglePinnedPageChipHandler,
  TogglePinnedSectionHandler,
} from './types'

// Volatile hover state shared across the dashboard. The provider carries a stable
// store rather than the current value so hover changes do not invalidate the whole
// context subtree. Leaf selectors are notified only when their selected snapshot
// changes (normally the old and new matching Page Chip / History row).
export type HoverState = {
  url: string
  urls: readonly string[]
  source: HoverUrlSource | null
}

export type HoverStateSelector<Selection> = (state: HoverState) => Selection

export type HoverStateStore = {
  getSnapshot: () => HoverState
  setSnapshot: (next: HoverState) => void
  subscribeSelector: <Selection>(
    selector: HoverStateSelector<Selection>,
    listener: () => void,
    equal?: (left: Selection, right: Selection) => boolean,
  ) => () => void
}

type HoverSelectorSubscription = {
  equal: (left: unknown, right: unknown) => boolean
  listener: () => void
  selected: unknown
  selector: HoverStateSelector<unknown>
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
  source: null,
}

function sameHoverState(left: HoverState, right: HoverState): boolean {
  return (
    left.url === right.url &&
    left.source === right.source &&
    left.urls.length === right.urls.length &&
    left.urls.every((url, index) => url === right.urls[index])
  )
}

export function createHoverStateStore(initialState: HoverState = defaultHoverState): HoverStateStore {
  let state = initialState
  const subscriptions = new Set<HoverSelectorSubscription>()

  function subscribeSelector<Selection>(
    selector: HoverStateSelector<Selection>,
    listener: () => void,
    equal: (left: Selection, right: Selection) => boolean = Object.is,
  ) {
    const subscription: HoverSelectorSubscription = {
      equal: (left, right) => equal(left as Selection, right as Selection),
      listener,
      selected: selector(state),
      selector,
    }
    subscriptions.add(subscription)
    return () => {
      subscriptions.delete(subscription)
    }
  }

  return {
    getSnapshot() {
      return state
    },
    setSnapshot(next) {
      if (sameHoverState(state, next)) return
      state = next
      for (const subscription of subscriptions) {
        const nextSelected = subscription.selector(next)
        if (subscription.equal(subscription.selected, nextSelected)) continue
        subscription.selected = nextSelected
        subscription.listener()
      }
    },
    subscribeSelector,
  }
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
