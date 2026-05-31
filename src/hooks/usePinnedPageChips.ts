import { useEffect, useMemo, useRef, useState } from 'react'
import { createPinnedPageChipIndex, loadPinnedPageChips, savePinnedPageChips, togglePinnedPageChipInList } from '../extension/page-chip-pins.js'
import type { PinnedPageChipIndex } from '../extension/page-chip-pins.js'

type UsePinnedPageChipsOptions = {
  onSaveError?: () => void
}

const EMPTY_PINNED_PAGE_CHIPS: PinnedPageChipIndex = new Map()

export function usePinnedPageChips({ onSaveError }: UsePinnedPageChipsOptions = {}) {
  const [pinnedPageChipIds, setPinnedPageChipIds] = useState<string[]>([])
  const [pageChipPinsLoaded, setPageChipPinsLoaded] = useState(false)
  const onSaveErrorRef = useRef(onSaveError)

  useEffect(() => {
    onSaveErrorRef.current = onSaveError
  }, [onSaveError])

  useEffect(() => {
    let cancelled = false
    loadPinnedPageChips().then((ids) => {
      if (cancelled) return
      setPinnedPageChipIds(ids)
      setPageChipPinsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const pinnedPageChips = useMemo<PinnedPageChipIndex>(
    () => pinnedPageChipIds.length === 0 ? EMPTY_PINNED_PAGE_CHIPS : createPinnedPageChipIndex(pinnedPageChipIds),
    [pinnedPageChipIds]
  )

  async function togglePinnedPageChip(id: string) {
    const nextIds = togglePinnedPageChipInList(pinnedPageChipIds, id)
    setPinnedPageChipIds(nextIds)
    try {
      await savePinnedPageChips(nextIds)
    } catch {
      onSaveErrorRef.current?.()
      setPinnedPageChipIds(pinnedPageChipIds)
    }
  }

  return { pinnedPageChips, pageChipPinsLoaded, togglePinnedPageChip }
}
