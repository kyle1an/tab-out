import { createContext, use, type ReactNode } from 'react'
import type { DashboardTabMutationTarget } from '../extension/types'

// Per-card local state only. Ambient, dashboard-wide interaction state (hover, layout,
// pin handlers) lives in DashboardInteractionContext so it can be provided once at the
// top instead of drilled down to every card.
export type DomainCardContextValue = {
  activeSuppressedTitle: string
  setActiveSuppressedTitle: (text: string) => void
  dedupeBadgesClosing: boolean
  suppressionCloseTargetsByText: Record<string, DashboardTabMutationTarget[]>
  suppressionSuspendTargetsByText: Record<string, DashboardTabMutationTarget[]>
}

const defaultDomainCardContext: DomainCardContextValue = {
  activeSuppressedTitle: '',
  setActiveSuppressedTitle: () => {},
  dedupeBadgesClosing: false,
  suppressionCloseTargetsByText: {},
  suppressionSuspendTargetsByText: {}
}

const DomainCardContext = createContext(defaultDomainCardContext)

export function DomainCardProvider({ value, children }: { value: DomainCardContextValue; children?: ReactNode }) {
  return <DomainCardContext.Provider value={value}>{children}</DomainCardContext.Provider>
}

export function useDomainCardContext() {
  return use(DomainCardContext)
}
