import { createContext, useContext, type ReactNode } from 'react'
import type { HoverUrlChangeHandler, LayoutChangeHandler } from './types'

export type DomainCardContextValue = {
  activeSuppressedTitle: string
  setActiveSuppressedTitle: (text: string) => void
  dedupeBadgesClosing: boolean
  onHoverUrlChange: HoverUrlChangeHandler | null
  onLayoutChange: LayoutChangeHandler | null
}

const defaultDomainCardContext: DomainCardContextValue = {
  activeSuppressedTitle: '',
  setActiveSuppressedTitle: () => {},
  dedupeBadgesClosing: false,
  onHoverUrlChange: null,
  onLayoutChange: null
}

const DomainCardContext = createContext(defaultDomainCardContext)

export function DomainCardProvider({ value, children }: { value: DomainCardContextValue; children?: ReactNode }) {
  return <DomainCardContext.Provider value={value}>{children}</DomainCardContext.Provider>
}

export function useDomainCardContext() {
  return useContext(DomainCardContext)
}
