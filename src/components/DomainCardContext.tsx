import { createContext, use, type ReactNode } from 'react'
import type { HoverUrlChangeHandler, HoverUrlSource, LayoutChangeHandler } from './types'

export type DomainCardContextValue = {
  activeSuppressedTitle: string
  setActiveSuppressedTitle: (text: string) => void
  dedupeBadgesClosing: boolean
  onHoverUrlChange: HoverUrlChangeHandler | null
  activeHoverUrl: string
  activeHoverUrls: readonly string[]
  activeHoverSource: HoverUrlSource | null
  onLayoutChange: LayoutChangeHandler | null
}

const defaultDomainCardContext: DomainCardContextValue = {
  activeSuppressedTitle: '',
  setActiveSuppressedTitle: () => {},
  dedupeBadgesClosing: false,
  onHoverUrlChange: null,
  activeHoverUrl: '',
  activeHoverUrls: [],
  activeHoverSource: null,
  onLayoutChange: null
}

const DomainCardContext = createContext(defaultDomainCardContext)

export function DomainCardProvider({ value, children }: { value: DomainCardContextValue; children?: ReactNode }) {
  return <DomainCardContext.Provider value={value}>{children}</DomainCardContext.Provider>
}

export function useDomainCardContext() {
  return use(DomainCardContext)
}
