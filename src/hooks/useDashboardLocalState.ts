import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DOMAIN_PIN_STORAGE_KEY,
  movePinnedDomainInList,
  normalizePinnedDomains,
  reorderPinnedDomainInList,
  savePinnedDomains,
  togglePinnedDomainInList,
  type PinnedDomainReorderPlacement
} from '../extension/domain-pins.js'
import { createPinnedPageChipIndex, normalizePinnedPageChips, PAGE_CHIP_PIN_STORAGE_KEY, savePinnedPageChips, togglePinnedPageChipInList, type PinnedPageChipIndex } from '../extension/page-chip-pins.js'
import { normalizePinnedSections, savePinnedSections, SECTION_PIN_STORAGE_KEY, togglePinnedSectionInList } from '../extension/section-pins.js'

export type DashboardLocalState = {
  loaded: boolean
  pinnedDomains: string[]
  pinnedSectionIds: string[]
  pinnedPageChipIds: string[]
}
type UseDashboardLocalStateOptions = {
  initialState?: DashboardLocalState | null
  onBeforeApplyPinnedDomains?: (options: { animate: boolean }) => void
  onBeforeApplyPinnedSections?: (sectionId: string) => void
  onBeforeApplyPinnedPageChips?: (pageChipPinId: string) => void
  onDomainPinSaveError?: () => void
  onSectionPinSaveError?: () => void
  onPageChipPinSaveError?: () => void
}

const DASHBOARD_LOCAL_STORAGE_KEYS = [
  DOMAIN_PIN_STORAGE_KEY,
  SECTION_PIN_STORAGE_KEY,
  PAGE_CHIP_PIN_STORAGE_KEY
]
const EMPTY_PINNED_SECTIONS: ReadonlySet<string> = new Set<string>()
const EMPTY_PINNED_PAGE_CHIPS: PinnedPageChipIndex = new Map()
const EMPTY_DASHBOARD_LOCAL_STATE: DashboardLocalState = {
  loaded: false,
  pinnedDomains: [],
  pinnedSectionIds: [],
  pinnedPageChipIds: []
}

function dashboardLocalStateFromStorage(stored: Record<string, unknown>): DashboardLocalState {
  return {
    loaded: true,
    pinnedDomains: normalizePinnedDomains(stored[DOMAIN_PIN_STORAGE_KEY]),
    pinnedSectionIds: normalizePinnedSections(stored[SECTION_PIN_STORAGE_KEY]),
    pinnedPageChipIds: normalizePinnedPageChips(stored[PAGE_CHIP_PIN_STORAGE_KEY])
  }
}

export async function loadDashboardLocalState(): Promise<DashboardLocalState> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ...EMPTY_DASHBOARD_LOCAL_STATE, loaded: true }
  }
  try {
    const stored = await chrome.storage.local.get(DASHBOARD_LOCAL_STORAGE_KEYS)
    return dashboardLocalStateFromStorage(stored)
  } catch {
    return { ...EMPTY_DASHBOARD_LOCAL_STATE, loaded: true }
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameDashboardLocalState(a: DashboardLocalState, b: DashboardLocalState): boolean {
  return a.loaded === b.loaded &&
    sameOrder(a.pinnedDomains, b.pinnedDomains) &&
    sameOrder(a.pinnedSectionIds, b.pinnedSectionIds) &&
    sameOrder(a.pinnedPageChipIds, b.pinnedPageChipIds)
}

export function useDashboardLocalState({
  initialState = null,
  onBeforeApplyPinnedDomains,
  onBeforeApplyPinnedSections,
  onBeforeApplyPinnedPageChips,
  onDomainPinSaveError,
  onSectionPinSaveError,
  onPageChipPinSaveError
}: UseDashboardLocalStateOptions = {}) {
  const [state, setState] = useState<DashboardLocalState>(initialState ?? EMPTY_DASHBOARD_LOCAL_STATE)
  const stateRef = useRef(state)
  const localMutationVersionRef = useRef(0)
  const onBeforeApplyPinnedDomainsRef = useRef(onBeforeApplyPinnedDomains)
  const onBeforeApplyPinnedSectionsRef = useRef(onBeforeApplyPinnedSections)
  const onBeforeApplyPinnedPageChipsRef = useRef(onBeforeApplyPinnedPageChips)
  const onDomainPinSaveErrorRef = useRef(onDomainPinSaveError)
  const onSectionPinSaveErrorRef = useRef(onSectionPinSaveError)
  const onPageChipPinSaveErrorRef = useRef(onPageChipPinSaveError)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    onBeforeApplyPinnedDomainsRef.current = onBeforeApplyPinnedDomains
    onBeforeApplyPinnedSectionsRef.current = onBeforeApplyPinnedSections
    onBeforeApplyPinnedPageChipsRef.current = onBeforeApplyPinnedPageChips
    onDomainPinSaveErrorRef.current = onDomainPinSaveError
    onSectionPinSaveErrorRef.current = onSectionPinSaveError
    onPageChipPinSaveErrorRef.current = onPageChipPinSaveError
  }, [onBeforeApplyPinnedDomains, onBeforeApplyPinnedSections, onBeforeApplyPinnedPageChips, onDomainPinSaveError, onSectionPinSaveError, onPageChipPinSaveError])

  useEffect(() => {
    let cancelled = false
    const mutationVersion = localMutationVersionRef.current
    // A cached state keeps the first paint fast, then this post-paint read makes sure a
    // just-changed pin cannot leave the mounted page using stale cached ordering.
    loadDashboardLocalState().then((nextState) => {
      if (cancelled || mutationVersion !== localMutationVersionRef.current) return
      const currentState = stateRef.current
      if (sameDashboardLocalState(currentState, nextState)) return
      if (!sameOrder(currentState.pinnedDomains, nextState.pinnedDomains)) {
        onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
      }
      stateRef.current = nextState
      setState(nextState)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const pinnedSections = useMemo<ReadonlySet<string>>(
    () => state.pinnedSectionIds.length === 0 ? EMPTY_PINNED_SECTIONS : new Set(state.pinnedSectionIds),
    [state.pinnedSectionIds]
  )
  const pinnedPageChips = useMemo<PinnedPageChipIndex>(
    () => state.pinnedPageChipIds.length === 0 ? EMPTY_PINNED_PAGE_CHIPS : createPinnedPageChipIndex(state.pinnedPageChipIds),
    [state.pinnedPageChipIds]
  )

  async function applyPinnedDomains(nextPinnedDomains: string[]) {
    if (sameOrder(nextPinnedDomains, state.pinnedDomains)) return
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedDomainsRef.current?.({ animate: true })
    const previous = state.pinnedDomains
    setState((current) => ({ ...current, pinnedDomains: nextPinnedDomains }))
    try {
      await savePinnedDomains(nextPinnedDomains)
    } catch {
      onDomainPinSaveErrorRef.current?.()
      setState((current) => ({ ...current, pinnedDomains: previous }))
    }
  }

  async function togglePinnedDomain(domain: string) {
    await applyPinnedDomains(togglePinnedDomainInList(state.pinnedDomains, domain))
  }

  async function reorderPinnedDomain(domain: string, placement: PinnedDomainReorderPlacement) {
    const nextPinnedDomains = 'direction' in placement
      ? movePinnedDomainInList(state.pinnedDomains, domain, placement.direction)
      : reorderPinnedDomainInList(state.pinnedDomains, domain, placement.targetDomain, placement.position)
    await applyPinnedDomains(nextPinnedDomains)
  }

  async function togglePinnedSection(id: string) {
    const nextIds = togglePinnedSectionInList(state.pinnedSectionIds, id)
    const previous = state.pinnedSectionIds
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedSectionsRef.current?.(id)
    setState((current) => ({ ...current, pinnedSectionIds: nextIds }))
    try {
      await savePinnedSections(nextIds)
    } catch {
      onSectionPinSaveErrorRef.current?.()
      onBeforeApplyPinnedSectionsRef.current?.(id)
      setState((current) => ({ ...current, pinnedSectionIds: previous }))
    }
  }

  async function togglePinnedPageChip(id: string) {
    const nextIds = togglePinnedPageChipInList(state.pinnedPageChipIds, id)
    const previous = state.pinnedPageChipIds
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedPageChipsRef.current?.(id)
    setState((current) => ({ ...current, pinnedPageChipIds: nextIds }))
    try {
      await savePinnedPageChips(nextIds)
    } catch {
      onPageChipPinSaveErrorRef.current?.()
      onBeforeApplyPinnedPageChipsRef.current?.(id)
      setState((current) => ({ ...current, pinnedPageChipIds: previous }))
    }
  }

  return {
    localStateLoaded: state.loaded,
    localState: state,
    pinnedDomains: state.pinnedDomains,
    pinnedSections,
    pinnedPageChips,
    togglePinnedDomain,
    reorderPinnedDomain,
    togglePinnedSection,
    togglePinnedPageChip
  }
}
