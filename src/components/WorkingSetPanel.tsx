import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { fetchWorkingSetSnapshot, focusWorkingSetItem } from '../extension/working-set-client.js'
import type { HoverUrlChangeHandler, TabsChangeHandler } from './types'
import type { WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'

let workingSetTitleResizeObserver: ResizeObserver | null = null
const workingSetTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: WorkingSetTitleMetrics) => void
>()

type WorkingSetTitleMetrics = {
  isTruncated: boolean
  width: number
}

interface WorkingSetPanelProps {
  snapshot: WorkingSetSnapshot | null
  onHoverUrlChange?: HoverUrlChangeHandler
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
}

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

function getWorkingSetTitleResizeObserver() {
  if (typeof ResizeObserver !== 'function') return null
  if (!workingSetTitleResizeObserver) {
    workingSetTitleResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) syncWorkingSetTitleFade(entry.target)
      }
    })
  }
  return workingSetTitleResizeObserver
}

function WorkingSetItemButton({ item, onHoverUrlChange, onSnapshotChange, onTabsChange }: {
  item: WorkingSetItem
  onHoverUrlChange?: HoverUrlChangeHandler
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [titleMetrics, setTitleMetrics] = useState<WorkingSetTitleMetrics>({
    isTruncated: false,
    width: 0
  })

  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const frameId = requestAnimationFrame(() => updateWorkingSetTitleTruncation(titleEl, setTitleMetrics))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    let disposed = false
    const observer = getWorkingSetTitleResizeObserver()
    workingSetTitleTruncationCallbacks.set(titleEl, (metrics) => {
      if (disposed) return
      setTitleMetrics((current) => sameWorkingSetTitleMetrics(current, metrics) ? current : metrics)
    })
    observer?.observe(titleEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (!disposed) updateWorkingSetTitleTruncation(titleEl, setTitleMetrics)
    }
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(onFontsDone)

    return () => {
      disposed = true
      observer?.unobserve(titleEl)
      workingSetTitleTruncationCallbacks.delete(titleEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
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

  const titleTooltipWidth = titleMetrics.width > 0 ? `${titleMetrics.width}px` : ''
  const titleTooltipStyle = titleTooltipWidth ? {
    '--working-set-title-tooltip-width': titleTooltipWidth
  } as CSSProperties : undefined
  const tooltipContent = titleMetrics.isTruncated ? (
    <span
      className={cn(
        'block max-w-[min(360px,calc(100vw-32px))] text-[13px] leading-tight text-tab-ink [overflow-wrap:break-word]',
        titleTooltipWidth && 'w-[var(--working-set-title-tooltip-width)]'
      )}
    >
      {item.title}
    </span>
  ) : undefined

  return (
    <TooltipAnchor
      content={tooltipContent}
      className="working-set-item-tooltip"
      style={titleTooltipStyle}
    >
      <button
        type="button"
        className={cn(
          'working-set-item group/working-set-item relative flex min-h-12 min-w-0 cursor-default items-center gap-2 rounded-xl border border-[var(--warm-gray)] bg-tab-card px-2 py-1.5 text-left text-[13px] leading-tight text-tab-ink outline-none [corner-shape:squircle] hover:border-[var(--accent-amber)] hover:bg-[rgba(82,82,82,0.08)] focus-visible:border-[var(--accent-amber)] focus-visible:ring-2 focus-visible:ring-[rgba(234,179,8,0.28)]',
          item.active && 'is-active-working-set-item bg-neutral-100 shadow-[0_1px_2px_rgba(10,10,10,0.07)]'
        )}
        aria-label={`Switch to ${item.title}`}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onMouseEnter}
        onBlur={onMouseLeave}
      >
        <span className={cn('grid h-4 w-4 flex-none place-items-center', !item.faviconUrl && 'invisible')}>
          {item.faviconUrl && <img className="block h-full w-full object-contain" src={item.faviconUrl} alt="" />}
        </span>
        <span className="flex min-w-0 flex-auto items-center">
          <span
            ref={titleRef}
            className="working-set-title block max-h-[calc(2lh)] min-w-0 flex-auto overflow-hidden hyphens-auto break-normal text-tab-ink [hyphenate-character:''] [overflow-wrap:anywhere] [&.working-set-title-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(100%_-_60px),rgba(0,0,0,0.35)_calc(100%_-_20px),transparent)]"
          >
            {item.title}
          </span>
        </span>
        {item.dupeCount > 1 && (
          <span className="working-set-dupe-badge inline-flex h-4 min-w-5 flex-none items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] px-1 text-[10px] font-semibold tabular-nums text-tab-muted">
            ×{item.dupeCount}
          </span>
        )}
      </button>
    </TooltipAnchor>
  )
}

export function WorkingSetPanel({ snapshot, onHoverUrlChange, onSnapshotChange, onTabsChange }: WorkingSetPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const items = snapshot?.items || []
  if (items.length === 0) return null

  const defaultLimit = snapshot?.defaultLimit || 8
  const expandedLimit = snapshot?.expandedLimit || 16
  const visibleLimit = expanded ? expandedLimit : defaultLimit
  const visibleItems = items.slice(0, visibleLimit)
  const hasMore = items.length > defaultLimit

  return (
    <section className="working-set-panel mb-4 min-w-0" aria-label="Recent workset">
      <div className="working-set-grid grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-1.5 max-[560px]:grid-cols-1">
        {visibleItems.map((item) => (
          <WorkingSetItemButton
            key={item.key}
            item={item}
            onHoverUrlChange={onHoverUrlChange}
            onSnapshotChange={onSnapshotChange}
            onTabsChange={onTabsChange}
          />
        ))}
        {hasMore && (
          <button
            type="button"
            className="working-set-item working-set-toggle relative flex min-h-12 min-w-0 cursor-default items-center justify-center gap-1.5 rounded-xl border border-[var(--warm-gray)] bg-tab-card px-2 py-1.5 text-[13px] font-medium leading-tight text-tab-muted outline-none [corner-shape:squircle] hover:border-[var(--accent-amber)] hover:bg-[rgba(82,82,82,0.08)] hover:text-tab-ink focus-visible:border-[var(--accent-amber)] focus-visible:ring-2 focus-visible:ring-[rgba(234,179,8,0.28)]"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </section>
  )
}
