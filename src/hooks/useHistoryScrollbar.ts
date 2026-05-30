import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

const HISTORY_ENTRY_SCROLLBAR_AXIS_PADDING_PX = 2
const HISTORY_ENTRY_SCROLLBAR_MIN_THUMB_HEIGHT_PX = 33
// How long the bar lingers after the last scroll/hover before fading out.
const HISTORY_ENTRY_SCROLLBAR_IDLE_HIDE_DELAY_MS = 2500
// Gap kept between the bar and an overlapping expansion popup when the bar
// carves that popup's band out of itself.
const HISTORY_ENTRY_SCROLLBAR_EXPANSION_CLEARANCE_PX = 0

export interface HistoryScrollbarMetrics {
  thumbHeight: number
  thumbTop: number
  visible: boolean
}

/** Vertical band, in the scrollbar's own coordinate space, to carve out. */
interface ScrollbarCutout {
  top: number
  bottom: number
}

export interface HistoryScrollbar {
  /** current painted-thumb geometry */
  metrics: HistoryScrollbarMetrics
  /** true while the bar should be revealed (recent scroll / hover / drag) */
  active: boolean
  /** clip-path for the bar so it visually yields to an overlapping expansion (or undefined) */
  clipPath: string | undefined
  /** attach to the scrollbar container element (the clip-path target) */
  containerRef: RefObject<HTMLDivElement | null>
  /** attach to the scrollbar track element */
  trackRef: RefObject<HTMLDivElement | null>
  /** wire to the thumb's onPointerDown (begins a drag) */
  onThumbPointerDown: (event: ReactPointerEvent) => void
  /** wire to the track's onPointerDown (jump-to-position) */
  onTrackPointerDown: (event: ReactPointerEvent) => void
  /** wire to the track's onPointerEnter (reveal) */
  onPointerEnter: () => void
  /** wire to the track's onPointerLeave (begin idle countdown) */
  onPointerLeave: () => void
  /** report the currently-expanded entry element (or null) so the bar can carve around it */
  setExpandedElement: (element: HTMLElement | null) => void
}

const DEFAULT_HISTORY_SCROLLBAR_METRICS: HistoryScrollbarMetrics = {
  thumbHeight: 0,
  thumbTop: 0,
  visible: false
}

function roundedCssPixel(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * Measure the vertical band an expanded entry covers, in the scrollbar
 * container's own coordinate space. Returns null when there is no overlap, so
 * the bar paints normally.
 */
function getScrollbarCutout(containerEl: HTMLElement | null, expandedEl: HTMLElement | null): ScrollbarCutout | null {
  if (!containerEl || !expandedEl) return null
  const containerRect = containerEl.getBoundingClientRect()
  const expandedRect = expandedEl.getBoundingClientRect()
  if (containerRect.height <= 0) return null
  // No horizontal reach into the bar's column → nothing to carve.
  if (expandedRect.right <= containerRect.left) return null

  const clearance = HISTORY_ENTRY_SCROLLBAR_EXPANSION_CLEARANCE_PX
  const top = clamp(expandedRect.top - containerRect.top - clearance, 0, containerRect.height)
  const bottom = clamp(expandedRect.bottom - containerRect.top + clearance, 0, containerRect.height)
  if (bottom - top <= 0) return null
  return { top: roundedCssPixel(top), bottom: roundedCssPixel(bottom) }
}

/** Build a clip-path that keeps the whole bar except the cutout band. */
function cutoutClipPath(cutout: ScrollbarCutout | null): string | undefined {
  if (!cutout) return undefined
  const { top, bottom } = cutout
  // Two stacked rectangles spanning full width: [0, top] and [bottom, 100%].
  // The band edges are px (container-space); the outer edges use 100% so no
  // layout read is needed at render time.
  return `polygon(0 0, 100% 0, 100% ${top}px, 0 ${top}px, 0 ${bottom}px, 100% ${bottom}px, 100% 100%, 0 100%)`
}

function scrollbarCutoutsEqual(left: ScrollbarCutout | null, right: ScrollbarCutout | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return Math.abs(left.top - right.top) < 0.1 && Math.abs(left.bottom - right.bottom) < 0.1
}

function getHistoryScrollbarMetrics(listEl: HTMLElement | null): HistoryScrollbarMetrics {
  if (!listEl) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const { clientHeight, scrollHeight, scrollTop } = listEl
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  if (clientHeight <= 0 || maxScrollTop <= 1) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const trackHeight = Math.max(0, clientHeight - HISTORY_ENTRY_SCROLLBAR_AXIS_PADDING_PX * 2)
  if (trackHeight <= 0) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const thumbHeight = Math.min(
    trackHeight,
    Math.max(HISTORY_ENTRY_SCROLLBAR_MIN_THUMB_HEIGHT_PX, trackHeight * (clientHeight / scrollHeight))
  )
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
  const thumbTop = maxThumbTop <= 0 ? 0 : (scrollTop / maxScrollTop) * maxThumbTop

  return {
    thumbHeight: roundedCssPixel(thumbHeight),
    thumbTop: roundedCssPixel(thumbTop),
    visible: true
  }
}

function historyScrollbarMetricsEqual(left: HistoryScrollbarMetrics, right: HistoryScrollbarMetrics): boolean {
  return (
    left.visible === right.visible &&
    Math.abs(left.thumbHeight - right.thumbHeight) < 0.1 &&
    Math.abs(left.thumbTop - right.thumbTop) < 0.1
  )
}

interface TrackGeometry {
  trackTop: number
  thumbHeight: number
  maxThumbTop: number
  maxScrollTop: number
}

/** Measure live geometry from the real DOM so drag/click stay pixel-accurate. */
function readTrackGeometry(listEl: HTMLElement, trackEl: HTMLElement): TrackGeometry {
  const trackRect = trackEl.getBoundingClientRect()
  const thumbEl = trackEl.firstElementChild
  const thumbHeight = thumbEl instanceof HTMLElement ? thumbEl.getBoundingClientRect().height : 0
  return {
    trackTop: trackRect.top,
    thumbHeight,
    maxThumbTop: Math.max(0, trackRect.height - thumbHeight),
    maxScrollTop: Math.max(0, listEl.scrollHeight - listEl.clientHeight)
  }
}

/**
 * Drives the styled overlay scrollbar that mirrors the natively-scrolling
 * history list. Adds what a painted thumb otherwise lacks:
 *   - a draggable thumb,
 *   - click-to-jump on the track,
 *   - browser-like auto-hide (reveal on scroll/hover/drag, fade when idle).
 *
 * Geometry stays in sync via a scroll listener plus a ResizeObserver on the
 * list and its content, so the caller only needs to pass the list ref and the
 * current row count (used to re-run the sync when the list contents change).
 */
export function useHistoryScrollbar(
  listRef: RefObject<HTMLDivElement | null>,
  rowCount: number
): HistoryScrollbar {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState(DEFAULT_HISTORY_SCROLLBAR_METRICS)
  const [active, setActive] = useState(false)
  const [cutout, setCutout] = useState<ScrollbarCutout | null>(null)

  // Imperative flags read inside timers/listeners (avoid stale-closure churn).
  const hideTimerRef = useRef<number | null>(null)
  const hoveringRef = useRef(false)
  const draggingRef = useRef(false)
  // The expanded entry the bar must carve around (set imperatively by the panel).
  const expandedElementRef = useRef<HTMLElement | null>(null)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleHide = useCallback(() => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      if (!hoveringRef.current && !draggingRef.current) setActive(false)
    }, HISTORY_ENTRY_SCROLLBAR_IDLE_HIDE_DELAY_MS)
  }, [clearHideTimer])

  const reveal = useCallback(() => {
    setActive(true)
    scheduleHide()
  }, [scheduleHide])

  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return

    let frameId = 0
    function updateScrollbar() {
      frameId = 0
      const nextMetrics = getHistoryScrollbarMetrics(listEl)
      setMetrics((current) => (
        historyScrollbarMetricsEqual(current, nextMetrics) ? current : nextMetrics
      ))
      const nextCutout = getScrollbarCutout(containerRef.current, expandedElementRef.current)
      setCutout((current) => (scrollbarCutoutsEqual(current, nextCutout) ? current : nextCutout))
    }
    function requestScrollbarUpdate() {
      if (frameId !== 0) return
      frameId = requestAnimationFrame(updateScrollbar)
    }
    function onScroll() {
      requestScrollbarUpdate()
      reveal()
    }

    updateScrollbar()
    listEl.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', requestScrollbarUpdate)

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(requestScrollbarUpdate)
      : null
    resizeObserver?.observe(listEl)
    const contentEl = listEl.firstElementChild
    if (contentEl instanceof HTMLElement) resizeObserver?.observe(contentEl)

    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId)
      listEl.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', requestScrollbarUpdate)
      resizeObserver?.disconnect()
    }
  }, [listRef, rowCount, reveal])

  const onTrackPointerDown = useCallback((event: ReactPointerEvent) => {
    const listEl = listRef.current
    const trackEl = trackRef.current
    if (!listEl || !trackEl) return
    event.preventDefault()

    const { trackTop, thumbHeight, maxThumbTop, maxScrollTop } = readTrackGeometry(listEl, trackEl)
    const desiredThumbTop = clamp(event.clientY - trackTop - thumbHeight / 2, 0, maxThumbTop)
    listEl.scrollTop = maxThumbTop > 0 ? (desiredThumbTop / maxThumbTop) * maxScrollTop : 0
    reveal()
  }, [listRef, reveal])

  const onThumbPointerDown = useCallback((event: ReactPointerEvent) => {
    const listEl = listRef.current
    const trackEl = trackRef.current
    if (!listEl || !trackEl) return
    // Stop the track handler (jump-to-position) from also firing.
    event.preventDefault()
    event.stopPropagation()

    draggingRef.current = true
    setActive(true)
    clearHideTimer()

    const { maxThumbTop, maxScrollTop } = readTrackGeometry(listEl, trackEl)
    const startY = event.clientY
    const startScrollTop = listEl.scrollTop

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const deltaScroll = maxThumbTop > 0
        ? ((moveEvent.clientY - startY) / maxThumbTop) * maxScrollTop
        : 0
      listEl.scrollTop = clamp(startScrollTop + deltaScroll, 0, maxScrollTop)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      scheduleHide()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [listRef, clearHideTimer, scheduleHide])

  const onPointerEnter = useCallback(() => {
    hoveringRef.current = true
    setActive(true)
    clearHideTimer()
  }, [clearHideTimer])

  const onPointerLeave = useCallback(() => {
    hoveringRef.current = false
    scheduleHide()
  }, [scheduleHide])

  // The panel reports which entry (if any) is expanded; remeasure the cutout
  // immediately so the bar carves around it on the next frame.
  const setExpandedElement = useCallback((element: HTMLElement | null) => {
    expandedElementRef.current = element
    const nextCutout = getScrollbarCutout(containerRef.current, element)
    setCutout((current) => (scrollbarCutoutsEqual(current, nextCutout) ? current : nextCutout))
  }, [])

  // Clean up any pending fade timer on unmount.
  useEffect(() => clearHideTimer, [clearHideTimer])

  const clipPath = cutoutClipPath(cutout)

  return {
    metrics,
    active,
    clipPath,
    containerRef,
    trackRef,
    onThumbPointerDown,
    onTrackPointerDown,
    onPointerEnter,
    onPointerLeave,
    setExpandedElement
  }
}
