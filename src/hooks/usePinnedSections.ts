import { useEffect, useMemo, useRef, useState } from 'react'
import { loadPinnedSections, savePinnedSections, togglePinnedSectionInList } from '../extension/section-pins.js'

type UsePinnedSectionsOptions = {
  onSaveError?: () => void
}

const EMPTY_PINNED_SECTIONS: ReadonlySet<string> = new Set<string>()

export function usePinnedSections({ onSaveError }: UsePinnedSectionsOptions = {}) {
  const [pinnedSectionIds, setPinnedSectionIds] = useState<string[]>([])
  const [sectionPinsLoaded, setSectionPinsLoaded] = useState(false)
  const onSaveErrorRef = useRef(onSaveError)

  useEffect(() => {
    onSaveErrorRef.current = onSaveError
  }, [onSaveError])

  useEffect(() => {
    let cancelled = false
    loadPinnedSections().then((ids) => {
      if (cancelled) return
      setPinnedSectionIds(ids)
      setSectionPinsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Set form is what the view-model layer needs for O(1) lookup at sort
  // time. Memoize so identity stays stable across renders that don't
  // change the pin list.
  const pinnedSections = useMemo<ReadonlySet<string>>(
    () => pinnedSectionIds.length === 0 ? EMPTY_PINNED_SECTIONS : new Set(pinnedSectionIds),
    [pinnedSectionIds]
  )

  async function togglePinnedSection(id: string) {
    const nextIds = togglePinnedSectionInList(pinnedSectionIds, id)
    setPinnedSectionIds(nextIds)
    try {
      await savePinnedSections(nextIds)
    } catch {
      onSaveErrorRef.current?.()
      setPinnedSectionIds(pinnedSectionIds)
    }
  }

  return { pinnedSections, sectionPinsLoaded, togglePinnedSection }
}
