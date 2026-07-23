import { DOMAIN_PIN_STORAGE_KEY, normalizePinnedDomains } from './domain-pins.js'
import { PAGE_CHIP_PIN_STORAGE_KEY, normalizePinnedPageChips } from './page-chip-pins.js'
import { normalizePinnedSections, SECTION_PIN_STORAGE_KEY } from './section-pins.js'

export type DashboardLocalState = {
  loaded: boolean
  pinnedDomains: string[]
  pinnedSectionIds: string[]
  pinnedPageChipIds: string[]
}

export type DashboardLocalStateLoadResult = {
  ok: boolean
  state: DashboardLocalState
}

export const DASHBOARD_LOCAL_STORAGE_KEYS = [
  DOMAIN_PIN_STORAGE_KEY,
  SECTION_PIN_STORAGE_KEY,
  PAGE_CHIP_PIN_STORAGE_KEY
] as const

export function emptyDashboardLocalState(loaded = false): DashboardLocalState {
  return {
    loaded,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }
}

function dashboardLocalStateFromStorage(stored: Record<string, unknown>): DashboardLocalState {
  return {
    loaded: true,
    pinnedDomains: normalizePinnedDomains(stored[DOMAIN_PIN_STORAGE_KEY]),
    pinnedSectionIds: normalizePinnedSections(stored[SECTION_PIN_STORAGE_KEY]),
    pinnedPageChipIds: normalizePinnedPageChips(stored[PAGE_CHIP_PIN_STORAGE_KEY])
  }
}

export function validDashboardLocalStateFromStorage(stored: Record<string, unknown>): DashboardLocalState | null {
  if (DASHBOARD_LOCAL_STORAGE_KEYS.some((key) => stored[key] !== undefined && !Array.isArray(stored[key]))) {
    return null
  }
  return dashboardLocalStateFromStorage(stored)
}

export async function loadDashboardLocalStateResult(): Promise<DashboardLocalStateLoadResult> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ok: true, state: emptyDashboardLocalState(true) }
  }
  try {
    const stored = await chrome.storage.local.get([...DASHBOARD_LOCAL_STORAGE_KEYS])
    const state = validDashboardLocalStateFromStorage(stored)
    return state
      ? { ok: true, state }
      : { ok: false, state: emptyDashboardLocalState(true) }
  } catch {
    return { ok: false, state: emptyDashboardLocalState(true) }
  }
}

export async function loadDashboardLocalState(): Promise<DashboardLocalState> {
  return (await loadDashboardLocalStateResult()).state
}

export function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function sameDashboardLocalState(
  left: DashboardLocalState | null,
  right: DashboardLocalState
): boolean {
  return left?.loaded === right.loaded &&
    sameStringOrder(left.pinnedDomains, right.pinnedDomains) &&
    sameStringOrder(left.pinnedSectionIds, right.pinnedSectionIds) &&
    sameStringOrder(left.pinnedPageChipIds, right.pinnedPageChipIds)
}
