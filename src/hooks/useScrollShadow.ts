import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Tracks whether a scroll region has been scrolled away from the top, so the
 * pinned header can drop its shadow. Owns the scroll-region ref via a callback
 * ref (so the initial scrollTop is read the moment the node mounts) plus a
 * passive scroll listener.
 */
export function useScrollShadow() {
  const [isScrolled, setIsScrolled] = useState(false)
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)

  const handleScrollRegionRef = useCallback((node: HTMLDivElement | null) => {
    scrollRegionRef.current = node
    const next = (node?.scrollTop || 0) > 0
    setIsScrolled((prev) => (prev === next ? prev : next))
  }, [])

  useEffect(() => {
    const scrollEl = scrollRegionRef.current
    if (!scrollEl) return
    const scrollTarget = scrollEl

    function onScroll() {
      const next = scrollTarget.scrollTop > 0
      setIsScrolled((prev) => (prev === next ? prev : next))
    }

    scrollTarget.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollTarget.removeEventListener('scroll', onScroll)
  }, [])

  return { isScrolled, handleScrollRegionRef }
}
