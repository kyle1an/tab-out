import {
  applyPinnedDomainMutation,
  DOMAIN_PIN_STORAGE_KEY,
  normalizePinnedDomains,
  type PinnedDomainMutation
} from './domain-pins.js'
import {
  applyPinnedPageChipMutation,
  normalizePinnedPageChips,
  PAGE_CHIP_PIN_STORAGE_KEY,
  type PinnedPageChipMutation
} from './page-chip-pins.js'
import {
  applyPinnedSectionMutation,
  normalizePinnedSections,
  SECTION_PIN_STORAGE_KEY,
  type PinnedSectionMutation
} from './section-pins.js'
import {
  createChromeStorageListMutationAdapter,
  createStorageListMutationStore,
  type StorageListMutationAttempt
} from './storage-list-mutations.js'
import { isDashboardLocalStoragePinValue } from './dashboard-local-state.js'

const pinnedDomainMutations = createStorageListMutationStore({
  adapter: createChromeStorageListMutationAdapter(DOMAIN_PIN_STORAGE_KEY),
  applyOperation: applyPinnedDomainMutation,
  isStoredValue: isDashboardLocalStoragePinValue,
  normalize: normalizePinnedDomains
})

const pinnedSectionMutations = createStorageListMutationStore({
  adapter: createChromeStorageListMutationAdapter(SECTION_PIN_STORAGE_KEY),
  applyOperation: applyPinnedSectionMutation,
  isStoredValue: isDashboardLocalStoragePinValue,
  normalize: normalizePinnedSections
})

const pinnedPageChipMutations = createStorageListMutationStore({
  adapter: createChromeStorageListMutationAdapter(PAGE_CHIP_PIN_STORAGE_KEY),
  applyOperation: applyPinnedPageChipMutation,
  isStoredValue: isDashboardLocalStoragePinValue,
  normalize: normalizePinnedPageChips
})

export function mutatePinnedDomains(
  mutation: PinnedDomainMutation
): Promise<StorageListMutationAttempt> {
  return pinnedDomainMutations.mutate(mutation)
}

export function mutatePinnedSections(
  mutation: PinnedSectionMutation
): Promise<StorageListMutationAttempt> {
  return pinnedSectionMutations.mutate(mutation)
}

export function mutatePinnedPageChips(
  mutation: PinnedPageChipMutation
): Promise<StorageListMutationAttempt> {
  return pinnedPageChipMutations.mutate(mutation)
}
