import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, MouseEvent, ReactNode, SetStateAction } from 'react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntry } from '../extension/tab-history.js'
import { markClosure } from '../extension/undo.js'
import { showToast } from '../extension/toast.js'
import { renderBionicTitleText } from './bionic-title-text'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { TabHistoryEntry } from '../extension/types'

let historyTitleResizeObserver: ResizeObserver | null = null
const HISTORY_TITLE_TOOLTIP_WRAP_EXTRA_PX = 24
const historyTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: HistoryTitleMetrics) => void
>()

type HistoryTitleMetrics = {
  isTruncated: boolean
  width: number
}

interface HistoryEntryProps {
  entry: TabHistoryEntry
  indexLabel: ReactNode
  snapshot: TabHistorySnapshot | null
  onSnapshotChange?: SnapshotChangeHandler
  onHoverUrlChange?: HoverUrlChangeHandler
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onTabsChange?: TabsChangeHandler
}

interface TabHistoryPanelProps {
  snapshot: TabHistorySnapshot | null
  onSnapshotChange?: SnapshotChangeHandler
  onHoverUrlChange?: HoverUrlChangeHandler
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onTabsChange?: TabsChangeHandler
}

function isHistoryTitleTruncated(titleEl: HTMLElement | null) {
  if (!titleEl) return false
  return titleEl.scrollWidth - titleEl.clientWidth > 1
}

function getHistoryTitleWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0
  return Math.round(titleEl.getBoundingClientRect().width * 100) / 100
}

function sameHistoryTitleMetrics(a: HistoryTitleMetrics, b: HistoryTitleMetrics) {
  return a.isTruncated === b.isTruncated && Math.abs(a.width - b.width) < 0.1
}

function syncHistoryTitleFade(titleEl: HTMLElement | null) {
  if (!titleEl) return { isTruncated: false, width: 0 }

  const isTruncated = isHistoryTitleTruncated(titleEl)
  const width = getHistoryTitleWidth(titleEl)
  const metrics = { isTruncated, width }
  titleEl.classList.toggle('history-entry-title-truncated', isTruncated)
  historyTitleTruncationCallbacks.get(titleEl)?.(metrics)
  return metrics
}

function updateTitleTruncation(
  titleEl: HTMLElement | null,
  setTitleMetrics: Dispatch<SetStateAction<HistoryTitleMetrics>>
) {
  const metrics = syncHistoryTitleFade(titleEl)
  setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
}

function getHistoryTitleResizeObserver() {
  if (typeof ResizeObserver !== 'function') return null
  if (!historyTitleResizeObserver) {
    historyTitleResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) syncHistoryTitleFade(entry.target)
      }
    })
  }
  return historyTitleResizeObserver
}

function entryBadges(entry: TabHistoryEntry, snapshot: TabHistorySnapshot | null) {
  const badges = []
  if (entry.cursor && !entry.current) badges.push('Cursor')
  if (snapshot?.activeWasInserted && entry.current) badges.push('Pending')
  if (entry.pinned) badges.push('Pinned')
  return badges
}

function historyEntryIndexLabel(entry: TabHistoryEntry, snapshot: TabHistorySnapshot | null, fallback: number): ReactNode {
  if (Number.isInteger(entry.index) && snapshot && Number.isInteger(snapshot.currentIndex) && snapshot.currentIndex >= 0) {
    const relativeIndex = entry.index - snapshot.currentIndex
    if (relativeIndex < 0) {
      return (
        <>
          <span>-</span>
          <span>{Math.abs(relativeIndex)}</span>
        </>
      )
    }
    return String(relativeIndex)
  }
  return String(fallback)
}

function HistoryEntry({ entry, indexLabel, snapshot, onSnapshotChange, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = [], activeHoverSource = null, onTabsChange }: HistoryEntryProps) {
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [titleMetrics, setTitleMetrics] = useState<HistoryTitleMetrics>({
    isTruncated: false,
    width: 0
  })

  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const frameId = requestAnimationFrame(() => updateTitleTruncation(titleEl, setTitleMetrics))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    let disposed = false
    const observer = getHistoryTitleResizeObserver()
    historyTitleTruncationCallbacks.set(titleEl, (metrics) => {
      if (disposed) return
      setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
    })
    observer?.observe(titleEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (!disposed) updateTitleTruncation(titleEl, setTitleMetrics)
    }
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(onFontsDone)

    return () => {
      disposed = true
      observer?.unobserve(titleEl)
      historyTitleTruncationCallbacks.delete(titleEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
    }
  }, [])

  async function refreshAfterMutation() {
    if (onTabsChange) {
      await onTabsChange()
      return
    }
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function onFocusEntry() {
    const focused = await focusHistoryEntry(entry)
    if (!focused) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function onCloseEntry(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const row = e.currentTarget.closest('.history-entry-row')
    const result = await closeHistoryEntry(entry)
    if (!result.closed) {
      showToast('Nothing to close')
      return
    }

    row?.classList.add('closing')
    await new Promise((resolve) => setTimeout(resolve, 160))
    onHoverUrlChange?.('')
    await refreshAfterMutation()

    if (result.snapshot.length > 0) {
      markClosure(result.snapshot, 'Tab closed')
    } else {
      showToast('Tab closed')
    }
  }

  function onMouseEnter() {
    onHoverUrlChange?.(entry.url || '', 'history', [entry.url || ''])
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  const badges = entryBadges(entry, snapshot)
  const activeInOtherWindow = !!entry.activeInOtherWindow && !entry.current
  const isActiveEntry = entry.active || entry.activeInOtherWindow
  const hoverMatched = !!activeHoverSource && activeHoverSource !== 'history' && !!entry.url && (entry.url === activeHoverUrl || activeHoverUrls.includes(entry.url))
  const entryLabel = entry.title || entry.displayUrl || entry.url
  const titleTooltipWidth = titleMetrics.width > 0
    ? `min(calc(100vw - 32px), ${Math.round((titleMetrics.width + HISTORY_TITLE_TOOLTIP_WRAP_EXTRA_PX) * 100) / 100}px)`
    : ''
  const titleTooltipStyle = titleTooltipWidth ? {
    '--history-entry-title-tooltip-width': titleTooltipWidth
  } as CSSProperties : undefined
  const titleTooltipContent = titleMetrics.isTruncated && entryLabel ? (
    <span
      className={cn(
        'history-entry-title-tooltip block min-w-0 max-w-[calc(100vw-32px)] whitespace-normal text-[13px] leading-tight font-normal text-tab-ink [font-family:inherit] [overflow-wrap:anywhere]',
        titleTooltipWidth && 'w-[var(--history-entry-title-tooltip-width)]'
      )}
    >
      {renderBionicTitleText(entryLabel, 'history-entry-tooltip')}
    </span>
  ) : undefined

  return (
    <div
      className="history-entry-row group/history-row flex min-h-9 w-full min-w-0 flex-none items-center gap-2 font-[inherit] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-[160ms] [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.96)]"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <span className="inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-[rgba(115,115,115,0.72)] group-hover/history-row:text-tab-muted group-focus-within/history-row:text-tab-muted">
        {indexLabel}
      </span>
      <div
        className={cn(
          "history-entry group/history-entry relative min-h-9 min-w-0 flex-auto rounded-[18px] border border-[var(--warm-gray)] bg-tab-card text-tab-ink [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-14 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:border-[var(--accent-amber)] focus-within:bg-tab-card focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
          entry.current && 'is-current current-active-history-entry border-transparent bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
          !entry.current && 'group-hover/history-row:border-[var(--accent-amber)] group-hover/history-row:bg-tab-card group-hover/history-row:after:opacity-100',
          isActiveEntry && 'is-active',
          activeInOtherWindow && 'active-in-other-window-history-entry border-[rgba(115,115,115,0.2)] bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)] group-hover/history-row:bg-[rgba(82,82,82,0.18)] [--history-entry-fade-bg:color-mix(in_srgb,var(--card-bg)_82%,rgb(82_82_82))]',
          entry.previousTarget && 'is-previous-target',
          entry.nextTarget && 'is-next-target',
          hoverMatched && 'history-entry-hover-match'
        )}
      >
        {entry.current && (
          <span
            className="active-history-entry-frame current-active-history-entry-frame pointer-events-none absolute inset-0 z-[2] rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)] [corner-shape:squircle]"
            aria-hidden="true"
          />
        )}
        <TooltipAnchor
          content={titleTooltipContent}
          className="history-entry-title-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word]"
          style={titleTooltipStyle}
        >
          <button
            type="button"
            className="flex min-h-8.5 w-full cursor-default items-center gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none disabled:cursor-default"
            disabled={!entry.exists}
            onClick={onFocusEntry}
          >
            <span className={cn('grid h-4 w-4 flex-none place-items-center', !entry.favIconUrl && 'invisible')}>
              {entry.favIconUrl && <img className="block h-full w-full object-contain" src={entry.favIconUrl} alt="" />}
            </span>
            <span className="flex min-w-0 flex-auto items-baseline gap-1.5">
              <span className="history-entry-title min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-tab-ink [font-size:inherit] [font-weight:inherit] [&.history-entry-title-truncated]:text-clip [&.history-entry-title-truncated]:[mask-image:linear-gradient(to_right,black_0,black_calc(100%_-_14px),transparent)]" ref={titleRef}>
                {renderBionicTitleText(entry.title, 'history-entry-title')}
              </span>
              {badges.length > 0 && (
                <span className="inline-flex flex-none items-center gap-1">
                  {badges.map((badge) => (
                    <span key={badge} className="whitespace-nowrap rounded-full bg-[rgba(115,115,115,0.08)] px-1.5 py-0.5 text-[10px] font-semibold text-tab-muted">
                      {badge}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
        </TooltipAnchor>
        <div className="pointer-events-none absolute top-1/2 right-1.5 z-2 flex -translate-y-1/2 items-center gap-0.5">
          <TooltipAnchor content="Close this tab">
            <button
              type="button"
              className="pointer-events-none inline-flex h-5.5 w-5.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent bg-transparent p-0 text-tab-muted opacity-0 leading-0 outline-none group-hover/history-row:pointer-events-auto group-hover/history-row:opacity-100 group-focus-within/history-entry:pointer-events-auto group-focus-within/history-entry:opacity-100 hover:border-tab-danger hover:bg-tab-card hover:text-tab-danger focus-visible:border-tab-danger focus-visible:bg-tab-card focus-visible:text-tab-danger focus-visible:outline-none disabled:hidden"
              disabled={!entry.exists}
              aria-label={`Close ${entry.title}`}
              onClick={onCloseEntry}
            >
              <svg className="block h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </TooltipAnchor>
        </div>
      </div>
    </div>
  )
}

export function TabHistoryPanel({ snapshot, onSnapshotChange, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = [], activeHoverSource = null, onTabsChange }: TabHistoryPanelProps) {
  const entries = snapshot?.entries || []
  const displayEntries = entries.slice().reverse()

  return (
    <section
      className="tab-history-panel sticky top-0 col-start-1 flex h-screen max-h-screen min-w-0 flex-col pl-[var(--dashboard-history-edge-gutter)] max-[900px]:static max-[900px]:ml-0 max-[900px]:mr-[var(--dashboard-scrollbar-inset)] max-[900px]:h-auto max-[900px]:max-h-[260px] max-[900px]:border-b max-[900px]:border-[var(--warm-gray)] max-[900px]:pr-0 max-[900px]:pb-0 max-[900px]:[.dashboard-shell.has-history_&]:[grid-column:1]"
      aria-label="Activation history"
    >
      <div className="history-entry-list flex min-h-0 min-w-0 flex-auto flex-col gap-1.5 overflow-y-auto pt-3 pr-3.5 pb-7.5 [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-0.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(115,115,115,0.28)] [&::-webkit-scrollbar-thumb:hover]:bg-[rgba(115,115,115,0.4)] max-[900px]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))] max-[900px]:[&::-webkit-scrollbar]:w-1">
        {displayEntries.length > 0 ? (
          displayEntries.map((entry, index) => (
            <HistoryEntry
              key={`${entry.windowId}:${entry.tabId}:${entry.index}`}
              entry={entry}
              indexLabel={historyEntryIndexLabel(entry, snapshot, index + 1)}
              snapshot={snapshot}
              onSnapshotChange={onSnapshotChange}
              onHoverUrlChange={onHoverUrlChange}
              activeHoverUrl={activeHoverUrl}
              activeHoverUrls={activeHoverUrls}
              activeHoverSource={activeHoverSource}
              onTabsChange={onTabsChange}
            />
          ))
        ) : (
          <div className="flex min-h-13.5 items-center text-[12px] text-tab-muted">No activation history yet.</div>
        )}
      </div>
    </section>
  )
}
