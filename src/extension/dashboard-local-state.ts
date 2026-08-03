import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
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

const dashboardLocalStoragePinValueSchema = Schema.UndefinedOr(Schema.Array(Schema.Unknown))

const storedDashboardLocalStateSchema = Schema.Struct({
  [DOMAIN_PIN_STORAGE_KEY]: Schema.optionalKey(dashboardLocalStoragePinValueSchema),
  [SECTION_PIN_STORAGE_KEY]: Schema.optionalKey(dashboardLocalStoragePinValueSchema),
  [PAGE_CHIP_PIN_STORAGE_KEY]: Schema.optionalKey(dashboardLocalStoragePinValueSchema)
})

type StoredDashboardLocalState = typeof storedDashboardLocalStateSchema.Type

const isStoredDashboardLocalState = Schema.is(storedDashboardLocalStateSchema)
const isStoredDashboardLocalStoragePinValue = Schema.is(dashboardLocalStoragePinValueSchema)

class DashboardLocalStateReadError extends Schema.TaggedErrorClass<DashboardLocalStateReadError>()(
  'DashboardLocalStateReadError',
  { cause: Schema.Defect() }
) {}

export function isDashboardLocalStoragePinValue(value: unknown): boolean {
  return isStoredDashboardLocalStoragePinValue(value)
}

export function emptyDashboardLocalState(loaded = false): DashboardLocalState {
  return {
    loaded,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }
}

function dashboardLocalStateFromStorage(stored: StoredDashboardLocalState): DashboardLocalState {
  return {
    loaded: true,
    pinnedDomains: normalizePinnedDomains(stored[DOMAIN_PIN_STORAGE_KEY]),
    pinnedSectionIds: normalizePinnedSections(stored[SECTION_PIN_STORAGE_KEY]),
    pinnedPageChipIds: normalizePinnedPageChips(stored[PAGE_CHIP_PIN_STORAGE_KEY])
  }
}

export function validDashboardLocalStateFromStorage(stored: unknown): DashboardLocalState | null {
  return isStoredDashboardLocalState(stored)
    ? dashboardLocalStateFromStorage(stored)
    : null
}

export const loadDashboardLocalStateResultEffect = Effect.fn(
  'dashboardLocalState.load'
)(function*() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ok: true, state: emptyDashboardLocalState(true) }
  }
  const stored = yield* Effect.result(Effect.tryPromise({
    try: () => chrome.storage.local.get([...DASHBOARD_LOCAL_STORAGE_KEYS]),
    catch: (cause) => DashboardLocalStateReadError.make({ cause })
  }))
  if (Result.isFailure(stored)) {
    return { ok: false, state: emptyDashboardLocalState(true) }
  }
  const state = validDashboardLocalStateFromStorage(stored.success)
  return state
    ? { ok: true, state }
    : { ok: false, state: emptyDashboardLocalState(true) }
})

export function loadDashboardLocalStateResult(): Promise<DashboardLocalStateLoadResult> {
  return getAppRuntime().runPromise(loadDashboardLocalStateResultEffect())
}

export const loadDashboardLocalStateEffect = Effect.fn(
  'dashboardLocalState.loadValue'
)(function*() {
  return (yield* loadDashboardLocalStateResultEffect()).state
})

export function loadDashboardLocalState(): Promise<DashboardLocalState> {
  return getAppRuntime().runPromise(loadDashboardLocalStateEffect())
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
