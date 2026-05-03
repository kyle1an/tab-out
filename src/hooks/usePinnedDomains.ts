import { useEffect, useRef, useState } from 'react'
import { loadPinnedDomains, savePinnedDomains, togglePinnedDomainInList } from '../extension/domain-pins.js'

type UsePinnedDomainsOptions = {
  onBeforeApplyPinnedDomains?: () => void
  onSaveError?: () => void
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
      onBeforeApplyPinnedDomainsRef.current?.()
      setPinnedDomains(domains)
      setPinsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function togglePinnedDomain(domain: string) {
    const nextPinnedDomains = togglePinnedDomainInList(pinnedDomains, domain)
    onBeforeApplyPinnedDomainsRef.current?.()
    setPinnedDomains(nextPinnedDomains)
    try {
      await savePinnedDomains(nextPinnedDomains)
    } catch {
      onSaveErrorRef.current?.()
      setPinnedDomains(pinnedDomains)
    }
  }

  return { pinnedDomains, pinsLoaded, togglePinnedDomain }
}
