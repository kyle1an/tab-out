import { useEffect, useRef, useState } from 'react'
import {
  loadPinnedDomains,
  movePinnedDomainInList,
  reorderPinnedDomainInList,
  savePinnedDomains,
  togglePinnedDomainInList
} from '../extension/domain-pins.js'
import type { PinnedDomainReorderPlacement } from '../extension/domain-pins.js'

type UsePinnedDomainsOptions = {
  onBeforeApplyPinnedDomains?: (options: { animate: boolean }) => void
  onSaveError?: () => void
}

function sameDomainOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((domain, index) => domain === b[index])
}

export function usePinnedDomains({ onBeforeApplyPinnedDomains, onSaveError }: UsePinnedDomainsOptions = {}) {
  const [pinnedDomains, setPinnedDomains] = useState<string[]>([])
  const [pinsLoaded, setPinsLoaded] = useState(false)
  const onBeforeApplyPinnedDomainsRef = useRef(onBeforeApplyPinnedDomains)
  const onSaveErrorRef = useRef(onSaveError)

  useEffect(() => {
    onBeforeApplyPinnedDomainsRef.current = onBeforeApplyPinnedDomains
    onSaveErrorRef.current = onSaveError
  }, [onBeforeApplyPinnedDomains, onSaveError])

  useEffect(() => {
    let cancelled = false
    loadPinnedDomains().then((domains) => {
      if (cancelled) return
      onBeforeApplyPinnedDomainsRef.current?.({ animate: false })
      setPinnedDomains(domains)
      setPinsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function applyPinnedDomains(nextPinnedDomains: string[]) {
    if (sameDomainOrder(nextPinnedDomains, pinnedDomains)) return
    onBeforeApplyPinnedDomainsRef.current?.({ animate: true })
    setPinnedDomains(nextPinnedDomains)
    try {
      await savePinnedDomains(nextPinnedDomains)
    } catch {
      onSaveErrorRef.current?.()
      setPinnedDomains(pinnedDomains)
    }
  }

  async function togglePinnedDomain(domain: string) {
    await applyPinnedDomains(togglePinnedDomainInList(pinnedDomains, domain))
  }

  async function reorderPinnedDomain(domain: string, placement: PinnedDomainReorderPlacement) {
    const nextPinnedDomains = 'direction' in placement
      ? movePinnedDomainInList(pinnedDomains, domain, placement.direction)
      : reorderPinnedDomainInList(pinnedDomains, domain, placement.targetDomain, placement.position)
    await applyPinnedDomains(nextPinnedDomains)
  }

  return { pinnedDomains, pinsLoaded, togglePinnedDomain, reorderPinnedDomain }
}
