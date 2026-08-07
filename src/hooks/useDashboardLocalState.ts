import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyPinnedDomainMutation,
  DOMAIN_PIN_STORAGE_KEY,
  normalizePinnedDomains,
  type PinnedDomainMutation,
  type PinnedDomainReorderPlacement
} from '../extension/domain-pins.js'
import { mutatePinnedDomains, mutatePinnedPageChips, mutatePinnedSections } from '../extension/dashboard-pin-mutations.js'
import { applyPinnedPageChipMutation, createPinnedPageChipIndex, normalizePinnedPageChips, PAGE_CHIP_PIN_STORAGE_KEY, type PinnedPageChipMutation, type PinnedPageChipIndex } from '../extension/page-chip-pins.js'
import { createSerializedStateWriter } from '../extension/serialized-state-writer.js'
import { applyPinnedSectionMutation, normalizePinnedSections, SECTION_PIN_STORAGE_KEY, type PinnedSectionMutation } from '../extension/section-pins.js'
import {
  emptyDashboardLocalState,
  isDashboardLocalStoragePinValue,
  loadDashboardLocalStateResult,
  sameDashboardLocalState,
  sameStringOrder,
  type DashboardLocalState
} from '../extension/dashboard-local-state.js'

export { loadDashboardLocalState, loadDashboardLocalStateResult } from '../extension/dashboard-local-state.js'
export type { DashboardLocalState, DashboardLocalStateLoadResult } from '../extension/dashboard-local-state.js'
type DashboardLocalStatePinKey = 'pinnedDomains' | 'pinnedSectionIds' | 'pinnedPageChipIds'
type DashboardLocalStatePendingWrites = Record<DashboardLocalStatePinKey, boolean>
type DashboardLocalStateStorageReconciliation = {
  appliedKeys: DashboardLocalStatePinKey[]
  nextState: DashboardLocalState
  persistedValues: Partial<Record<DashboardLocalStatePinKey, string[]>>
}
type UseDashboardLocalStateOptions = {
  initialState?: DashboardLocalState | null
  waitForInitialState?: boolean
  onBeforeApplyPinnedDomains?: (options: { animate: boolean }) => void
  onBeforeApplyPinnedSections?: (sectionId: string) => void
  onBeforeApplyPinnedPageChips?: (pageChipPinId: string) => void
  onDomainPinSaveError?: () => void
  onSectionPinSaveError?: () => void
  onPageChipPinSaveError?: () => void
}

const EMPTY_PINNED_SECTIONS: ReadonlySet<string> = new Set<string>()
const EMPTY_PINNED_PAGE_CHIPS: PinnedPageChipIndex = new Map()
const EMPTY_DASHBOARD_LOCAL_STATE = emptyDashboardLocalState()

/**
 * Reconcile one local-storage event with the page's optimistic pin state.
 * Persisted values are always returned so writers can rebase their rollback
 * baseline. A pin kind with a local write in flight keeps its optimistic UI;
 * that writer's eventual result will apply the storage-backed final value.
 */
export function reconcileDashboardLocalStateStorageChanges(
  currentState: DashboardLocalState,
  changes: Record<string, chrome.storage.StorageChange>,
  pendingWrites: DashboardLocalStatePendingWrites
): DashboardLocalStateStorageReconciliation | null {
  let nextState = currentState
  const appliedKeys: DashboardLocalStatePinKey[] = []
  const persistedValues: Partial<Record<DashboardLocalStatePinKey, string[]>> = {}
  let recognizedChange = false

  function reconcilePinValue(
    storageKey: string,
    stateKey: DashboardLocalStatePinKey,
    normalize: (value: unknown) => string[]
  ): void {
    if (!Object.hasOwn(changes, storageKey)) return
    const nextValue = changes[storageKey]?.newValue
    // Match the initial-load failure contract: malformed persisted pin state is
    // unknown, not an intentional empty list. A removed key is intentionally [].
    if (!isDashboardLocalStoragePinValue(nextValue)) return
    recognizedChange = true
    const normalizedValue = normalize(nextValue)
    persistedValues[stateKey] = normalizedValue
    if (pendingWrites[stateKey] || sameStringOrder(currentState[stateKey], normalizedValue)) return
    nextState = { ...nextState, [stateKey]: normalizedValue }
    appliedKeys.push(stateKey)
  }

  reconcilePinValue(DOMAIN_PIN_STORAGE_KEY, 'pinnedDomains', normalizePinnedDomains)
  reconcilePinValue(SECTION_PIN_STORAGE_KEY, 'pinnedSectionIds', normalizePinnedSections)
  reconcilePinValue(PAGE_CHIP_PIN_STORAGE_KEY, 'pinnedPageChipIds', normalizePinnedPageChips)

  return recognizedChange ? { appliedKeys, nextState, persistedValues } : null
}

function changedPinnedValue(before: readonly string[], after: readonly string[]): string {
  return before.find((value) => !after.includes(value)) ??
    after.find((value) => !before.includes(value)) ??
    after.find((value, index) => value !== before[index]) ??
    ''
}

export function useDashboardLocalState({
  initialState = null,
  waitForInitialState = false,
  onBeforeApplyPinnedDomains,
  onBeforeApplyPinnedSections,
  onBeforeApplyPinnedPageChips,
  onDomainPinSaveError,
  onSectionPinSaveError,
  onPageChipPinSaveError
}: UseDashboardLocalStateOptions = {}) {
  const [state, setState] = useState<DashboardLocalState>(initialState ?? EMPTY_DASHBOARD_LOCAL_STATE)
  const stateRef = useRef(state)
  const [domainPinWriter] = useState(() => createSerializedStateWriter<PinnedDomainMutation>(state.pinnedDomains, mutatePinnedDomains))
  const [sectionPinWriter] = useState(() => createSerializedStateWriter<PinnedSectionMutation>(state.pinnedSectionIds, mutatePinnedSections))
  const [pageChipPinWriter] = useState(() => createSerializedStateWriter<PinnedPageChipMutation>(state.pinnedPageChipIds, mutatePinnedPageChips))
  const localMutationVersionRef = useRef(0)
  const pendingPinWritesRef = useRef<Record<DashboardLocalStatePinKey, number>>({
    pinnedDomains: 0,
    pinnedSectionIds: 0,
    pinnedPageChipIds: 0
  })
  const onBeforeApplyPinnedDomainsRef = useRef(onBeforeApplyPinnedDomains)
  const onBeforeApplyPinnedSectionsRef = useRef(onBeforeApplyPinnedSections)
  const onBeforeApplyPinnedPageChipsRef = useRef(onBeforeApplyPinnedPageChips)
  const onDomainPinSaveErrorRef = useRef(onDomainPinSaveError)
  const onSectionPinSaveErrorRef = useRef(onSectionPinSaveError)
  const onPageChipPinSaveErrorRef = useRef(onPageChipPinSaveError)

  function applyStartupState(nextState: DashboardLocalState) {
    localMutationVersionRef.current += 1
    domainPinWriter.replacePersisted(nextState.pinnedDomains)
    sectionPinWriter.replacePersisted(nextState.pinnedSectionIds)
    pageChipPinWriter.replacePersisted(nextState.pinnedPageChipIds)
    const currentState = stateRef.current
    if (sameDashboardLocalState(currentState, nextState)) return
    if (!sameStringOrder(currentState.pinnedDomains, nextState.pinnedDomains)) {
      onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
    }
    stateRef.current = nextState
    setState(nextState)
  }

  useEffect(() => {
    onBeforeApplyPinnedDomainsRef.current = onBeforeApplyPinnedDomains
    onBeforeApplyPinnedSectionsRef.current = onBeforeApplyPinnedSections
    onBeforeApplyPinnedPageChipsRef.current = onBeforeApplyPinnedPageChips
    onDomainPinSaveErrorRef.current = onDomainPinSaveError
    onSectionPinSaveErrorRef.current = onSectionPinSaveError
    onPageChipPinSaveErrorRef.current = onPageChipPinSaveError
  }, [onBeforeApplyPinnedDomains, onBeforeApplyPinnedSections, onBeforeApplyPinnedPageChips, onDomainPinSaveError, onSectionPinSaveError, onPageChipPinSaveError])

  useEffect(() => {
    if (waitForInitialState) return
    let cancelled = false
    const mutationVersion = localMutationVersionRef.current
    // Re-read after admission to close the handoff to the hook's storage-event
    // subscription. Equality suppresses a second render when nothing changed.
    loadDashboardLocalStateResult().then(({ ok, state: nextState }) => {
      if (cancelled || mutationVersion !== localMutationVersionRef.current) return
      const currentState = stateRef.current
      // A transient storage read must not replace a valid initial state with
      // empty arrays or redefine the writer's rollback baseline. With no warm
      // state, still mark the shell loaded so a storage outage cannot block it.
      if (!ok && currentState.loaded) return
      if (sameDashboardLocalState(currentState, nextState)) return
      if (!sameStringOrder(currentState.pinnedDomains, nextState.pinnedDomains)) {
        onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
      }
      if (ok) {
        domainPinWriter.replacePersisted(nextState.pinnedDomains)
        sectionPinWriter.replacePersisted(nextState.pinnedSectionIds)
        pageChipPinWriter.replacePersisted(nextState.pinnedPageChipIds)
      }
      stateRef.current = nextState
      setState(nextState)
    })
    return () => {
      cancelled = true
    }
  }, [domainPinWriter, pageChipPinWriter, sectionPinWriter, waitForInitialState])

  useEffect(() => {
    if (waitForInitialState) return
    const storageChanges = globalThis.chrome?.storage?.onChanged
    if (!storageChanges?.addListener) return

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      const pendingWrites = pendingPinWritesRef.current
      const currentState = stateRef.current
      const reconciliation = reconcileDashboardLocalStateStorageChanges(currentState, changes, {
        pinnedDomains: pendingWrites.pinnedDomains > 0,
        pinnedSectionIds: pendingWrites.pinnedSectionIds > 0,
        pinnedPageChipIds: pendingWrites.pinnedPageChipIds > 0
      })
      if (!reconciliation) return

      // Prevent an earlier post-paint storage read from overwriting this newer event.
      localMutationVersionRef.current += 1
      if (reconciliation.persistedValues.pinnedDomains) {
        domainPinWriter.replacePersisted(reconciliation.persistedValues.pinnedDomains)
      }
      if (reconciliation.persistedValues.pinnedSectionIds) {
        sectionPinWriter.replacePersisted(reconciliation.persistedValues.pinnedSectionIds)
      }
      if (reconciliation.persistedValues.pinnedPageChipIds) {
        pageChipPinWriter.replacePersisted(reconciliation.persistedValues.pinnedPageChipIds)
      }
      if (sameDashboardLocalState(currentState, reconciliation.nextState)) return

      if (reconciliation.appliedKeys.includes('pinnedDomains')) {
        onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
      }
      if (reconciliation.appliedKeys.includes('pinnedSectionIds')) {
        onBeforeApplyPinnedSectionsRef.current?.(changedPinnedValue(
          currentState.pinnedSectionIds,
          reconciliation.nextState.pinnedSectionIds
        ))
      }
      if (reconciliation.appliedKeys.includes('pinnedPageChipIds')) {
        onBeforeApplyPinnedPageChipsRef.current?.(changedPinnedValue(
          currentState.pinnedPageChipIds,
          reconciliation.nextState.pinnedPageChipIds
        ))
      }
      stateRef.current = reconciliation.nextState
      setState(reconciliation.nextState)
    }

    storageChanges.addListener(onStorageChanged)
    return () => storageChanges.removeListener(onStorageChanged)
  }, [domainPinWriter, pageChipPinWriter, sectionPinWriter, waitForInitialState])

  const pinnedSections = useMemo<ReadonlySet<string>>(
    () => state.pinnedSectionIds.length === 0 ? EMPTY_PINNED_SECTIONS : new Set(state.pinnedSectionIds),
    [state.pinnedSectionIds]
  )
  const pinnedPageChips = useMemo<PinnedPageChipIndex>(
    () => state.pinnedPageChipIds.length === 0 ? EMPTY_PINNED_PAGE_CHIPS : createPinnedPageChipIndex(state.pinnedPageChipIds),
    [state.pinnedPageChipIds]
  )

  function updateCurrentState(update: (current: DashboardLocalState) => DashboardLocalState): void {
    const nextState = update(stateRef.current)
    stateRef.current = nextState
    setState(nextState)
  }

  async function withPendingPinWrite<Value>(
    stateKey: DashboardLocalStatePinKey,
    write: () => Promise<Value>,
    settle: (value: Value) => void
  ): Promise<void> {
    pendingPinWritesRef.current[stateKey] += 1
    const release = () => {
      pendingPinWritesRef.current[stateKey] -= 1
    }
    // Keep storage-event reconciliation pending until the authoritative result
    // has been applied. Promise chaining also avoids a render-compiler bailout
    // for try/finally inside this hook.
    return Promise.resolve()
      .then(write)
      .then(settle)
      .then(release, (error) => {
        release()
        throw error
      })
  }

  async function applyPinnedDomainMutationOptimistically(mutation: PinnedDomainMutation) {
    const nextPinnedDomains = applyPinnedDomainMutation(stateRef.current.pinnedDomains, mutation)
    if (sameStringOrder(nextPinnedDomains, stateRef.current.pinnedDomains)) return
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedDomainsRef.current?.({ animate: true })
    updateCurrentState((current) => ({ ...current, pinnedDomains: nextPinnedDomains }))
    await withPendingPinWrite('pinnedDomains', () => domainPinWriter.write(mutation), (result) => {
      if (!result.isLatest) return
      const value = result.ok === true ? result.value : result.rollbackValue
      if (!sameStringOrder(stateRef.current.pinnedDomains, value)) {
        onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
        updateCurrentState((current) => ({ ...current, pinnedDomains: value }))
      }
      if (result.ok === false) onDomainPinSaveErrorRef.current?.()
    })
  }

  async function togglePinnedDomain(domain: string) {
    await applyPinnedDomainMutationOptimistically({
      type: 'set-pinned',
      domain,
      pinned: !stateRef.current.pinnedDomains.includes(domain)
    })
  }

  async function reorderPinnedDomain(domain: string, placement: PinnedDomainReorderPlacement) {
    await applyPinnedDomainMutationOptimistically({ type: 'reorder', domain, placement })
  }

  async function togglePinnedSection(id: string) {
    const mutation: PinnedSectionMutation = {
      type: 'set-pinned',
      id,
      pinned: !stateRef.current.pinnedSectionIds.includes(id)
    }
    const nextIds = applyPinnedSectionMutation(stateRef.current.pinnedSectionIds, mutation)
    if (sameStringOrder(nextIds, stateRef.current.pinnedSectionIds)) return
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedSectionsRef.current?.(id)
    updateCurrentState((current) => ({ ...current, pinnedSectionIds: nextIds }))
    await withPendingPinWrite('pinnedSectionIds', () => sectionPinWriter.write(mutation), (result) => {
      if (!result.isLatest) return
      const value = result.ok === true ? result.value : result.rollbackValue
      if (!sameStringOrder(stateRef.current.pinnedSectionIds, value)) {
        onBeforeApplyPinnedSectionsRef.current?.(id)
        updateCurrentState((current) => ({ ...current, pinnedSectionIds: value }))
      }
      if (result.ok === false) onSectionPinSaveErrorRef.current?.()
    })
  }

  async function togglePinnedPageChip(id: string) {
    const mutation: PinnedPageChipMutation = {
      type: 'set-pinned',
      id,
      pinned: !stateRef.current.pinnedPageChipIds.includes(id)
    }
    const nextIds = applyPinnedPageChipMutation(stateRef.current.pinnedPageChipIds, mutation)
    if (sameStringOrder(nextIds, stateRef.current.pinnedPageChipIds)) return
    localMutationVersionRef.current += 1
    onBeforeApplyPinnedPageChipsRef.current?.(id)
    updateCurrentState((current) => ({ ...current, pinnedPageChipIds: nextIds }))
    await withPendingPinWrite('pinnedPageChipIds', () => pageChipPinWriter.write(mutation), (result) => {
      if (!result.isLatest) return
      const value = result.ok === true ? result.value : result.rollbackValue
      if (!sameStringOrder(stateRef.current.pinnedPageChipIds, value)) {
        onBeforeApplyPinnedPageChipsRef.current?.(id)
        updateCurrentState((current) => ({ ...current, pinnedPageChipIds: value }))
      }
      if (result.ok === false) onPageChipPinSaveErrorRef.current?.()
    })
  }

  return {
    localStateLoaded: state.loaded,
    localState: state,
    pinnedDomains: state.pinnedDomains,
    pinnedSections,
    pinnedPageChips,
    applyStartupState,
    togglePinnedDomain,
    reorderPinnedDomain,
    togglePinnedSection,
    togglePinnedPageChip
  }
}
