import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, EyeOff } from 'lucide-react'
import { dismissWorkingSetItem, fetchWorkingSetSnapshot, focusWorkingSetItem } from '../extension/working-set-client.js'
import { animateWorkingSetItemMoves, cancelWorkingSetItemMoves, snapshotWorkingSetItemPositions } from '../extension/working-set-move-animation.js'
import { DefaultFavicon } from './DefaultFavicon'
import { bionicTitleTextNodes } from './bionic-title-text'
import { captureVisibleLineHtml, clampedTitleLineNodes, syncTruncatedTitleFadeEnd } from './expanded-text-layout'
import type { HoverUrlChangeHandler, HoverUrlSource, LayoutChangeHandler, TabsChangeHandler } from './types'
import type { WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import type { WorkingSetItemPosition, WorkingSetItemPositionMap } from '../extension/working-set-move-animation.js'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { CSSVariableProperties } from '@/lib/css-properties'

let workingSetTitleResizeObserver: ResizeObserver | null = null
const workingSetTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: WorkingSetTitleMetrics) => void
>()

type WorkingSetTitleMetrics = {
  isTruncated: boolean
  width: number
}

type WorkingSetTitleClamp = {
  key: string
  lineHtml: string[]
  width: number
}

type WorkingSetExitItem = {
  item: WorkingSetItem
  position: WorkingSetItemPosition
}

interface WorkingSetPanelProps {
  snapshot: WorkingSetSnapshot | null
  onHoverUrlChange?: HoverUrlChangeHandler
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
  onBeforeLayoutChange?: LayoutChangeHandler | null
  onAfterLayoutChange?: LayoutChangeHandler | null
}

const EMPTY_HOVER_URLS: readonly string[] = []
const WORKING_SET_TITLE_CLAMP_WIDTH_TOLERANCE_PX = 0.5

function isWorkingSetTitleTruncated(titleEl: HTMLElement | null) {
  if (!titleEl) return false
  return (
    titleEl.scrollHeight - titleEl.clientHeight > 1 ||
    titleEl.scrollWidth - titleEl.clientWidth > 1
  )
}

function getWorkingSetTitleWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0
  return Math.round(titleEl.getBoundingClientRect().width * 100) / 100
}

function sameWorkingSetTitleMetrics(a: WorkingSetTitleMetrics, b: WorkingSetTitleMetrics) {
  return a.isTruncated === b.isTruncated && Math.abs(a.width - b.width) < 0.1
}

function syncWorkingSetTitleFade(titleEl: HTMLElement | null) {
  if (!titleEl) return { isTruncated: false, width: 0 }

  const isTruncated = isWorkingSetTitleTruncated(titleEl)
  const width = getWorkingSetTitleWidth(titleEl)
  const metrics = { isTruncated, width }
  titleEl.classList.toggle('working-set-title-truncated', isTruncated)
  syncTruncatedTitleFadeEnd(titleEl, isTruncated)
  workingSetTitleTruncationCallbacks.get(titleEl)?.(metrics)
  return metrics
}

function updateWorkingSetTitleTruncation(
  titleEl: HTMLElement | null,
  setTitleMetrics: Dispatch<SetStateAction<WorkingSetTitleMetrics>>
) {
  const metrics = syncWorkingSetTitleFade(titleEl)
  setTitleMetrics((current) => sameWorkingSetTitleMetrics(current, metrics) ? current : metrics)
}

function cancelWorkingSetExitTimers(
  frameRef: { current: number },
  timeoutRef: { current: number }
) {
  cancelAnimationFrame(frameRef.current)
  window.clearTimeout(timeoutRef.current)
}

function getWorkingSetTitleResizeObserver() {
  if (!workingSetTitleResizeObserver) {
    workingSetTitleResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) syncWorkingSetTitleFade(entry.target)
      }
    })
  }
  return workingSetTitleResizeObserver
}

function hashWorkingSetLayoutKey(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function workingSetItemLayoutKey(item: WorkingSetItem) {
  return `ws-${hashWorkingSetLayoutKey(item.key || `${item.windowId}:${item.tabId}`)}`
}

function workingSetVisibleLayoutSignature(items: WorkingSetItem[], hasMore: boolean, expanded: boolean) {
  const itemKeys = items.map(workingSetItemLayoutKey)
  if (hasMore) itemKeys.push(`__working-set-toggle__:${expanded ? 'expanded' : 'collapsed'}`)
  return itemKeys.join('\n')
}

function WorkingSetItemGhost({ item, position, exiting }: { item: WorkingSetItem; position: WorkingSetItemPosition; exiting: boolean }) {
  const style: CSSVariableProperties = {
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
    height: `${position.height}px`
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        'working-set-exit-ghost working-set-item pointer-events-none absolute flex min-w-0 cursor-default items-center gap-2 overflow-hidden rounded-[18px] border border-(--warm-gray) bg-tab-card px-2 py-1.5 text-left text-[13px] leading-tight text-tab-ink outline-none [corner-shape:squircle]',
        exiting && 'is-exiting'
      )}
      style={style}
    >
      <span className="relative grid size-4 flex-none place-items-center">
        {item.faviconUrl ? <img className="block h-full w-full object-contain" src={item.faviconUrl} alt="" /> : <DefaultFavicon />}
        {item.dupeCount > 1 && (
          <span
            className={cn(
              'working-set-dupe-badge chip-dupe-badge pointer-events-none absolute -top-[7px] -right-[7px] z-1 box-border inline-flex size-4 min-w-4 items-center justify-center rounded-full bg-[rgba(254,243,199,0.98)] px-0 text-[9px] leading-none font-bold tabular-nums text-[rgb(120,53,15)] shadow-[0_1px_2px_rgba(10,10,10,0.14)]',
              item.dupeCount > 9 && 'chip-dupe-badge-wide w-auto rounded-lg px-1 [corner-shape:squircle]'
            )}
          >
            <span className="-translate-y-[1px]">{item.dupeCount}</span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-auto items-center">
        <span className="working-set-title block max-h-[calc(2lh)] min-w-0 flex-auto overflow-hidden hyphens-auto break-normal text-tab-ink [hyphenate-character:''] [overflow-wrap:anywhere]">
          {bionicTitleTextNodes(item.title, `working-set-ghost-${item.key}`)}
        </span>
      </span>
    </div>
  )
}

function WorkingSetItemButton({ item, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = EMPTY_HOVER_URLS, activeHoverSource = null, onSnapshotChange, onTabsChange }: {
  item: WorkingSetItem
  onHoverUrlChange?: HoverUrlChangeHandler
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [titleMetrics, setTitleMetrics] = useState<WorkingSetTitleMetrics>({
    isTruncated: false,
    width: 0
  })
  const [titleClamp, setTitleClamp] = useState<WorkingSetTitleClamp | null>(null)

  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const frameId = requestAnimationFrame(() => updateWorkingSetTitleTruncation(titleEl, setTitleMetrics))
    return () => cancelAnimationFrame(frameId)
  })

  // Same invalidate-then-recapture contract as the history-title clamp effect:
  // a truncated title swaps to captured-line rows whose overflowing tail keeps
  // the fade mask over glyphs; stale captures drop first so the re-capture
  // always measures the natural wrapped layout.
  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const width = getWorkingSetTitleWidth(titleEl)
    if (titleClamp && (titleClamp.key !== item.title || Math.abs(titleClamp.width - width) >= WORKING_SET_TITLE_CLAMP_WIDTH_TOLERANCE_PX)) {
      setTitleClamp(null)
      return
    }
    if (titleClamp || width <= 0) return

    const metrics = syncWorkingSetTitleFade(titleEl)
    if (!metrics.isTruncated) return
    const styles = window.getComputedStyle(titleEl)
    const lineHeight = Number.parseFloat(styles.lineHeight)
    if (!lineHeight || !Number.isFinite(lineHeight)) return
    const visibleLineCount = Math.max(1, Math.round(titleEl.getBoundingClientRect().height / lineHeight))
    if (visibleLineCount <= 1) return
    const lineHtml = captureVisibleLineHtml(titleEl, visibleLineCount)
    if (lineHtml.length <= 1) return
    setTitleClamp({ key: item.title, lineHtml, width })
    // titleMetrics carries the observer-reported width, so width changes re-run
    // this effect even though the effect reads the live rect itself.
  }, [titleClamp, item.title, titleMetrics])

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    let disposed = false
    const observer = getWorkingSetTitleResizeObserver()
    workingSetTitleTruncationCallbacks.set(titleEl, (metrics) => {
      if (disposed) return
      setTitleMetrics((current) => sameWorkingSetTitleMetrics(current, metrics) ? current : metrics)
    })
    observer.observe(titleEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (disposed) return
      setTitleClamp(null)
      updateWorkingSetTitleTruncation(titleEl, setTitleMetrics)
    }
    fontSet.addEventListener('loadingdone', onFontsDone)
    fontSet.ready.then(onFontsDone)

    return () => {
      disposed = true
      observer.unobserve(titleEl)
      workingSetTitleTruncationCallbacks.delete(titleEl)
      fontSet.removeEventListener('loadingdone', onFontsDone)
    }
  }, [])

  async function onClick() {
    const focused = await focusWorkingSetItem(item)
    if (!focused) return
    onSnapshotChange?.(await fetchWorkingSetSnapshot())
    await onTabsChange?.()
  }

  function onMouseEnter() {
    onHoverUrlChange?.(item.tabUrl, 'working-set', [item.tabUrl, item.rawUrl])
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  function onBlurWithin(event: ReactFocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    onMouseLeave()
  }

  async function onDismiss(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    onHoverUrlChange?.('')
    onSnapshotChange?.(await dismissWorkingSetItem(item))
  }

  const titleTooltipWidth = titleMetrics.width > 0 ? `${titleMetrics.width}px` : ''
  const titleTooltipStyle: CSSVariableProperties | undefined = titleTooltipWidth ? {
    '--working-set-title-tooltip-width': titleTooltipWidth
  } : undefined
  const hoverMatched = !!activeHoverSource && activeHoverSource !== 'working-set' && !!item.tabUrl && (
    item.tabUrl === activeHoverUrl ||
    item.rawUrl === activeHoverUrl ||
    activeHoverUrls.includes(item.tabUrl) ||
    activeHoverUrls.includes(item.rawUrl)
  )
  const tooltipContent = titleMetrics.isTruncated ? (
    <span
      className={cn(
        'block max-w-[min(360px,calc(100vw-32px))] text-[13px] leading-tight text-tab-ink wrap-break-word',
        titleTooltipWidth && 'w-(--working-set-title-tooltip-width)'
      )}
    >
      {bionicTitleTextNodes(item.title, `working-set-tooltip-${item.key}`)}
    </span>
  ) : undefined
  const itemStyle: CSSVariableProperties = {
    '--working-set-hover-fade-bg': item.active
      ? 'color-mix(in srgb, var(--card-bg) 88%, var(--accent-amber))'
      : 'color-mix(in srgb, var(--card-bg) 92%, rgb(82 82 82))'
  }
  const duplicateLabel = item.dupeCount > 1 ? `${item.dupeCount} open copies` : ''
  const itemLabel = [`Switch to ${item.title}`, duplicateLabel].filter(Boolean).join(', ')

  return (
    <div
      data-tabout="working-set-item"
      className="working-set-item-shell working-set-layout-item group/working-set-item relative min-w-0"
      data-working-set-layout-key={workingSetItemLayoutKey(item)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onBlurWithin}
    >
      <TooltipAnchor
        content={tooltipContent}
        className="working-set-item-tooltip"
        style={titleTooltipStyle}
      >
        <button
          type="button"
          className={cn(
            "working-set-item relative flex min-h-12 w-full min-w-0 cursor-default items-center gap-2 rounded-[18px] border border-(--warm-gray) bg-tab-card px-2 py-1.5 text-left text-[13px] leading-tight text-tab-ink outline-none [corner-shape:squircle] hover:border-(--accent-amber) hover:bg-[rgba(82,82,82,0.08)] focus-visible:border-(--accent-amber) focus-visible:ring-2 focus-visible:ring-[rgba(234,179,8,0.28)] group-hover/working-set-item:border-(--accent-amber) group-hover/working-set-item:bg-[rgba(82,82,82,0.08)] group-focus-within/working-set-item:border-(--accent-amber) after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--working-set-hover-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] group-hover/working-set-item:after:opacity-100 group-focus-within/working-set-item:after:opacity-100",
            item.active && 'is-active-working-set-item bg-neutral-100 shadow-[0_1px_2px_rgba(10,10,10,0.07)]',
            hoverMatched && 'working-set-item-hover-match'
          )}
          style={itemStyle}
          aria-label={itemLabel}
          onClick={onClick}
        >
          <span className="relative grid size-4 flex-none place-items-center">
            {item.faviconUrl ? (
              <img className="block h-full w-full object-contain" src={item.faviconUrl} alt="" />
            ) : (
              <DefaultFavicon />
            )}
            {item.dupeCount > 1 && (
              <span
                className={cn(
                  'working-set-dupe-badge chip-dupe-badge pointer-events-none absolute -top-[7px] -right-[7px] z-1 box-border inline-flex size-4 min-w-4 items-center justify-center rounded-full bg-[rgba(254,243,199,0.98)] px-0 text-[9px] leading-none font-bold tabular-nums text-[rgb(120,53,15)] shadow-[0_1px_2px_rgba(10,10,10,0.14)]',
                  item.dupeCount > 9 && 'chip-dupe-badge-wide w-auto rounded-lg px-1 [corner-shape:squircle]'
                )}
                aria-hidden="true"
              >
                <span className="-translate-y-[1px]">
                  {item.dupeCount}
                </span>
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-auto items-center">
            <span
              ref={titleRef}
              className="working-set-title block max-h-[calc(2lh)] min-w-0 flex-auto overflow-hidden hyphens-auto break-normal text-tab-ink [hyphenate-character:''] [overflow-wrap:anywhere] [&.working-set-title-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(var(--title-fade-end,100%)_-_60px),rgba(0,0,0,0.35)_calc(var(--title-fade-end,100%)_-_20px),transparent_var(--title-fade-end,100%))]"
            >
              {titleClamp && titleClamp.key === item.title && titleClamp.lineHtml.length > 1
                ? clampedTitleLineNodes(titleClamp.lineHtml, `working-set-title-${item.key}`)
                : bionicTitleTextNodes(item.title, `working-set-title-${item.key}`)}
            </span>
          </span>
        </button>
      </TooltipAnchor>
      <div className="working-set-actions absolute top-1/2 right-2 z-2 flex -translate-y-1/2 items-center gap-0.5">
        <TooltipAnchor content="Dismiss from working set">
          <button
            type="button"
            data-tabout-part="dismiss-button"
            className="working-set-dismiss pointer-events-none inline-flex shrink-0 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-1 text-tab-muted opacity-0 outline-none transition-[opacity,color,background] duration-150 group-hover/working-set-item:pointer-events-auto group-hover/working-set-item:opacity-100 group-focus-within/working-set-item:pointer-events-auto group-focus-within/working-set-item:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:text-tab-ink hover:opacity-100 focus-visible:bg-[rgba(82,82,82,0.1)] focus-visible:text-tab-ink focus-visible:opacity-100"
            aria-label={`Dismiss ${item.title} from working set`}
            onClick={onDismiss}
          >
            <EyeOff className="size-[15px]" aria-hidden="true" />
          </button>
        </TooltipAnchor>
      </div>
    </div>
  )
}

export function WorkingSetPanel({ snapshot, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = EMPTY_HOVER_URLS, activeHoverSource = null, onSnapshotChange, onTabsChange, onBeforeLayoutChange = null, onAfterLayoutChange = null }: WorkingSetPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const animatedGridRef = useRef<HTMLDivElement | null>(null)
  const itemPositionsRef = useRef<WorkingSetItemPositionMap | null>(null)
  const pendingLayoutChangeRef = useRef(false)
  const onAfterLayoutChangeRef = useRef(onAfterLayoutChange)
  const exitFrameRef = useRef(0)
  const exitTimeoutRef = useRef(0)
  const [exitingItems, setExitingItems] = useState<WorkingSetExitItem[]>([])
  const [exitActive, setExitActive] = useState(false)
  const items = snapshot?.items || []
  const defaultLimit = snapshot?.defaultLimit || 8
  const expandedLimit = snapshot?.expandedLimit || 16
  const visibleLimit = expanded ? expandedLimit : defaultLimit
  const visibleItems = items.slice(0, visibleLimit)
  const hasMore = items.length > defaultLimit
  const layoutSignature = workingSetVisibleLayoutSignature(visibleItems, hasMore, expanded)

  useLayoutEffect(() => {
    onAfterLayoutChangeRef.current = onAfterLayoutChange
  }, [onAfterLayoutChange])

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (animatedGridRef.current && animatedGridRef.current !== grid) cancelWorkingSetItemMoves(animatedGridRef.current)
    animatedGridRef.current = grid
    const nextPositions = snapshotWorkingSetItemPositions(grid)
    animateWorkingSetItemMoves(grid, itemPositionsRef.current)
    itemPositionsRef.current = nextPositions
    if (pendingLayoutChangeRef.current) {
      pendingLayoutChangeRef.current = false
      onAfterLayoutChangeRef.current?.({ animate: true })
    }
  }, [layoutSignature])

  useEffect(() => {
    const animatedGrid = animatedGridRef.current
    return () => {
      cancelWorkingSetItemMoves(animatedGrid)
      cancelWorkingSetExitTimers(exitFrameRef, exitTimeoutRef)
    }
  }, [])

  if (items.length === 0) return null

  function clearExitingItems() {
    cancelWorkingSetExitTimers(exitFrameRef, exitTimeoutRef)
    setExitActive(false)
    setExitingItems([])
  }

  function startCollapseExitAnimation() {
    const positions = itemPositionsRef.current || snapshotWorkingSetItemPositions(gridRef.current)
    const outgoingItems = items
      .slice(defaultLimit, visibleLimit)
      .map((item) => {
        const position = positions.get(workingSetItemLayoutKey(item))
        return position ? { item, position } : null
      })
      .filter((item): item is WorkingSetExitItem => !!item)

    if (outgoingItems.length === 0) {
      clearExitingItems()
      return
    }

    cancelWorkingSetExitTimers(exitFrameRef, exitTimeoutRef)
    setExitActive(false)
    setExitingItems(outgoingItems)
    exitFrameRef.current = requestAnimationFrame(() => setExitActive(true))
    exitTimeoutRef.current = window.setTimeout(() => {
      setExitActive(false)
      setExitingItems([])
    }, 260)
  }

  function onToggleExpanded() {
    const nextExpanded = !expanded
    pendingLayoutChangeRef.current = true
    onBeforeLayoutChange?.({ animate: true })
    if (nextExpanded) clearExitingItems()
    else startCollapseExitAnimation()
    setExpanded(nextExpanded)
  }

  return (
    <section data-tabout="working-set" className="working-set-panel mb-4 min-w-0" aria-label="Recent workset">
      <div ref={gridRef} className="working-set-grid relative grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-1.5 max-[560px]:grid-cols-1">
        {visibleItems.map((item) => (
          <WorkingSetItemButton
            key={item.key}
            item={item}
            onHoverUrlChange={onHoverUrlChange}
            activeHoverUrl={activeHoverUrl}
            activeHoverUrls={activeHoverUrls}
            activeHoverSource={activeHoverSource}
            onSnapshotChange={onSnapshotChange}
            onTabsChange={onTabsChange}
          />
        ))}
        {exitingItems.map(({ item, position }) => (
          <WorkingSetItemGhost key={`exit-${item.key}`} item={item} position={position} exiting={exitActive} />
        ))}
        {hasMore && (
          <button
            type="button"
            data-tabout-part="toggle-button"
            className="working-set-item working-set-toggle working-set-layout-item relative flex min-h-12 min-w-0 cursor-default items-center justify-center gap-1.5 rounded-[18px] border border-(--warm-gray) bg-tab-card px-2 py-1.5 text-[13px] font-medium leading-tight text-tab-muted outline-none [corner-shape:squircle] hover:border-(--accent-amber) hover:bg-[rgba(82,82,82,0.08)] hover:text-tab-ink focus-visible:border-(--accent-amber) focus-visible:ring-2 focus-visible:ring-[rgba(234,179,8,0.28)]"
            data-working-set-layout-key="__working-set-toggle__"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </section>
  )
}
