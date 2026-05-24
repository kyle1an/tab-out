import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, KeyboardEvent, MouseEvent, ReactNode, SetStateAction } from 'react'
import { X } from 'lucide-react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntry } from '../extension/tab-history.js'
import { focusWorkingSetItem } from '../extension/working-set-client.js'
import { markClosure } from '../extension/undo.js'
import { showToast } from '../extension/toast.js'
import { DefaultFavicon } from './DefaultFavicon'
import { bionicTitleTextNodes } from './bionic-title-text'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { TabHistoryEntry, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'

let historyTitleResizeObserver: ResizeObserver | null = null
const HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX = 8
const HISTORY_TITLE_TOOLTIP_TEXT_RIGHT_INSET_PX = 8
const HISTORY_TITLE_TOOLTIP_TEXT_TOP_INSET_PX = 4
const HISTORY_TITLE_TOOLTIP_SINGLE_LINE_EXTRA_PX = 96
const HISTORY_TITLE_TOOLTIP_SINGLE_LINE_RATIO = 1.45
const HISTORY_WORKING_SET_NOISY_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source'
])
const LOW_SCORE_HISTORY_PROTOCOLS = new Set([
  'about:',
  'brave:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'edge:'
])
const historyTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: HistoryTitleMetrics) => void
>()
const EMPTY_HOVER_URLS: readonly string[] = []

type HistoryTitleMetrics = {
  contentWidth: number
  isTruncated: boolean
  left: number
  mainWidth: number
  width: number
}

type HistoryWorkingSetMatch = {
  item: WorkingSetItem
}

interface HistoryEntryProps {
  entry: TabHistoryEntry
  indexLabel: ReactNode
  snapshot: TabHistorySnapshot | null
  workingSetMatch?: HistoryWorkingSetMatch | null
  workingSetItem?: WorkingSetItem | null
  dimmed?: boolean
  onSnapshotChange?: SnapshotChangeHandler
  onHoverUrlChange?: HoverUrlChangeHandler
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onTabsChange?: TabsChangeHandler
}

interface TabHistoryPanelProps {
  snapshot: TabHistorySnapshot | null
  workingSet?: WorkingSetSnapshot | null
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
  return (
    Math.abs(a.contentWidth - b.contentWidth) < 0.1 &&
    a.isTruncated === b.isTruncated &&
    Math.abs(a.left - b.left) < 0.1 &&
    Math.abs(a.mainWidth - b.mainWidth) < 0.1 &&
    Math.abs(a.width - b.width) < 0.1
  )
}

function syncHistoryTitleFade(titleEl: HTMLElement | null) {
  if (!titleEl) return { contentWidth: 0, isTruncated: false, left: 0, mainWidth: 0, width: 0 }

  const isTruncated = isHistoryTitleTruncated(titleEl)
  const rect = titleEl.getBoundingClientRect()
  const mainEl = titleEl.closest('.history-entry-main')
  const left = Math.round(rect.left * 100) / 100
  const mainWidth = mainEl instanceof HTMLElement ? Math.round(mainEl.getBoundingClientRect().width * 100) / 100 : 0
  const contentWidth = Math.round(titleEl.scrollWidth * 100) / 100
  const width = getHistoryTitleWidth(titleEl)
  const metrics = { contentWidth, isTruncated, left, mainWidth, width }
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

function workingSetUrls(item: WorkingSetItem | null | undefined) {
  return item ? [item.tabUrl, item.rawUrl, item.key].filter(Boolean) : []
}

function uniqueUrls(urls: readonly string[]) {
  return [...new Set(urls.filter(Boolean))]
}

function historyEntryWorkingSetKey(entry: TabHistoryEntry) {
  return pageIdentityForHistoryWorkingSet(entry.url || entry.displayUrl || '')
}

function pageIdentityForHistoryWorkingSet(url = ''): string {
  const effectiveUrl = unwrapHistoryWorkingSetSuspenderUrl(url || '')
  if (!effectiveUrl) return ''

  try {
    const parsed = new URL(effectiveUrl)
    if (LOW_SCORE_HISTORY_PROTOCOLS.has(parsed.protocol)) {
      return ''
    }
    if (
      (parsed.hostname === 'www.google.com' || parsed.hostname === 'google.com') &&
      parsed.pathname === '/search'
    ) {
      return ''
    }

    parsed.hash = ''
    const cleanParams = new URLSearchParams()
    const paramEntries = Array.from(parsed.searchParams.entries())
      .filter(([name]) => !name.toLowerCase().startsWith('utm_') && !HISTORY_WORKING_SET_NOISY_QUERY_PARAMS.has(name.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [name, value] of paramEntries) cleanParams.append(name, value)
    parsed.search = cleanParams.toString()

    if (parsed.protocol === 'file:') return parsed.href

    const pathname = parsed.pathname || '/'
    const path = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
    const query = parsed.search ? parsed.search : ''
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`
  } catch {
    return ''
  }
}

function unwrapHistoryWorkingSetSuspenderUrl(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return url || ''
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.endsWith('/suspended.html')) return url
    const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
    const marker = '&uri='
    const markerIndex = fragment.indexOf(marker)
    const encoded = markerIndex >= 0 ? fragment.slice(markerIndex + marker.length) : fragment.startsWith('uri=') ? fragment.slice(4) : ''
    return encoded ? decodeURIComponent(encoded) || url : url
  } catch {
    return url
  }
}

function isLowScoreHistoryUrl(url = '') {
  const effectiveUrl = unwrapHistoryWorkingSetSuspenderUrl(url || '')
  if (!effectiveUrl) return false

  try {
    return LOW_SCORE_HISTORY_PROTOCOLS.has(new URL(effectiveUrl).protocol)
  } catch {
    return false
  }
}

function isLowScoreHistoryEntry(entry: TabHistoryEntry) {
  return !!entry.isApp || isLowScoreHistoryUrl(entry.url || entry.displayUrl || '')
}

function makeWorkingSetMatches(items: readonly WorkingSetItem[]) {
  const matches = new Map<string, HistoryWorkingSetMatch>()
  items.forEach((item) => {
    if (!item.key || matches.has(item.key)) return
    matches.set(item.key, { item })
  })
  return matches
}

function historyEntryFromWorkingSetItem(item: WorkingSetItem): TabHistoryEntry {
  return {
    index: -1,
    tabId: item.tabId,
    windowId: item.windowId,
    exists: true,
    active: item.active,
    activeInOtherWindow: item.activeInOtherWindow,
    isApp: false,
    pinned: false,
    discarded: false,
    cursor: false,
    current: item.active && !item.activeInOtherWindow,
    previousTarget: false,
    nextTarget: false,
    title: item.title,
    url: item.tabUrl,
    displayUrl: item.displayUrl,
    favIconUrl: item.faviconUrl
  }
}

function shouldDimHistoryEntry(entry: TabHistoryEntry, workingSetMatch: HistoryWorkingSetMatch | null, hasWorkingSetSignals: boolean) {
  if (isLowScoreHistoryEntry(entry)) return true

  return (
    hasWorkingSetSignals &&
    !workingSetMatch &&
    !entry.current &&
    !entry.active &&
    !entry.activeInOtherWindow &&
    !entry.previousTarget &&
    !entry.nextTarget
  )
}

function HistoryEntry({ entry, indexLabel, snapshot, workingSetMatch = null, workingSetItem = null, dimmed = false, onSnapshotChange, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = EMPTY_HOVER_URLS, activeHoverSource = null, onTabsChange }: HistoryEntryProps) {
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [titleMetrics, setTitleMetrics] = useState<HistoryTitleMetrics>({
    contentWidth: 0,
    isTruncated: false,
    left: 0,
    mainWidth: 0,
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
    if (workingSetItem) {
      const focused = await focusWorkingSetItem(workingSetItem)
      if (!focused) return
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
      return
    }

    const focused = await focusHistoryEntry(entry)
    if (!focused) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  function onEntryKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!entry.exists) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    void onFocusEntry()
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
    const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
    const hoverUrl = workingSetItem?.tabUrl || entry.url || ''
    const hoverUrls = uniqueUrls([
      entry.url || '',
      ...(workingSetItem ? workingSetUrls(workingSetItem) : workingSetUrls(workingSetMatch?.item))
    ])
    onHoverUrlChange?.(hoverUrl, hoverSource, hoverUrls)
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  const isWorkingSetExtra = !!workingSetItem
  const badges = isWorkingSetExtra ? [] : entryBadges(entry, snapshot)
  const canCloseEntry = !isWorkingSetExtra && entry.exists
  const activeInOtherWindow = !!entry.activeInOtherWindow && !entry.current
  const isActiveEntry = entry.active || entry.activeInOtherWindow
  const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
  const matchUrls = uniqueUrls([
    entry.url || '',
    ...(workingSetItem ? workingSetUrls(workingSetItem) : workingSetUrls(workingSetMatch?.item))
  ])
  const hoverMatched = !!activeHoverSource && activeHoverSource !== hoverSource && matchUrls.some((url) => url === activeHoverUrl || activeHoverUrls.includes(url))
  const isWorkingSetPriority = !!workingSetMatch || !!workingSetItem
  const isIndexHighlighted = !dimmed && (isActiveEntry || entry.previousTarget || entry.nextTarget || isWorkingSetPriority || hoverMatched)
  const entryLabel = entry.title || entry.displayUrl || entry.url
  const faviconUrl = entry.favIconUrl || workingSetMatch?.item.faviconUrl || workingSetItem?.faviconUrl || ''
  const titleTooltipPopupLeft = Math.max(0, titleMetrics.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX)
  const titleTooltipAvailableTextWidth = typeof window === 'undefined'
    ? Math.max(1, titleMetrics.contentWidth || titleMetrics.mainWidth || titleMetrics.width)
    : Math.max(1, window.innerWidth - Math.max(0, titleMetrics.left) - 16)
  const titleTooltipSingleLineLimit = Math.max(
    titleMetrics.mainWidth * HISTORY_TITLE_TOOLTIP_SINGLE_LINE_RATIO,
    titleMetrics.mainWidth + HISTORY_TITLE_TOOLTIP_SINGLE_LINE_EXTRA_PX
  )
  const titleTooltipShouldWrap = titleMetrics.contentWidth > titleTooltipSingleLineLimit
  const titleTooltipBalancedWidth = Math.max(
    titleMetrics.mainWidth + HISTORY_TITLE_TOOLTIP_SINGLE_LINE_EXTRA_PX,
    titleMetrics.contentWidth / 2
  )
  const titleTooltipTargetTextWidth = Math.min(
    titleTooltipAvailableTextWidth,
    titleTooltipShouldWrap ? titleTooltipBalancedWidth : titleMetrics.contentWidth || titleTooltipAvailableTextWidth
  )
  const titleTooltipStyle = {
    '--history-entry-title-tooltip-text-max-width': `${Math.round(Math.max(1, titleTooltipTargetTextWidth) * 100) / 100}px`,
    maxWidth: `calc(100vw - ${titleTooltipPopupLeft}px - 8px)`,
    paddingLeft: `${HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX}px`,
    paddingRight: `${HISTORY_TITLE_TOOLTIP_TEXT_RIGHT_INSET_PX}px`
  } as CSSProperties
  const titleTooltipTextStyle = {
    maxWidth: 'var(--history-entry-title-tooltip-text-max-width)'
  } as CSSProperties
  function getHistoryTitleTooltipAnchor() {
    const titleEl = titleRef.current
    if (!titleEl) return null

    const rect = titleEl.getBoundingClientRect()
    const left = rect.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX
    const top = rect.top - HISTORY_TITLE_TOOLTIP_TEXT_TOP_INSET_PX

    return {
      getBoundingClientRect: () => new DOMRect(left, top, 0, 0)
    }
  }
  const titleTooltipContent = titleMetrics.isTruncated && entryLabel ? (
    <span
      className="history-entry-title-tooltip line-clamp-2 max-w-[calc(100vw-32px)] whitespace-normal break-normal text-[13px] leading-tight font-normal text-tab-ink [font-family:inherit] [overflow-wrap:break-word] [text-wrap:balance] [width:max-content]"
      style={titleTooltipTextStyle}
    >
      {bionicTitleTextNodes(entryLabel, 'history-entry-tooltip')}
    </span>
  ) : undefined

  return (
    <div
      className={cn(
        'history-entry-row group/history-row flex min-h-9 w-full min-w-0 flex-none items-center gap-2 font-[inherit] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-[160ms] [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.96)]',
        dimmed && 'history-entry-low-score opacity-60 hover:opacity-100 focus-within:opacity-100',
        isWorkingSetExtra && 'history-working-set-extra'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <span className={cn(
        'inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-[rgba(115,115,115,0.42)] group-hover/history-row:text-[rgba(64,64,64,0.76)] group-focus-within/history-row:text-[rgba(64,64,64,0.76)]',
        isIndexHighlighted && 'history-entry-index-highlight font-semibold text-tab-ink group-hover/history-row:text-tab-ink group-focus-within/history-row:text-tab-ink',
        isWorkingSetPriority && !dimmed && 'text-[color-mix(in_srgb,var(--accent-amber)_88%,var(--ink))]',
        !isIndexHighlighted && 'history-entry-index-muted',
        dimmed && 'text-[rgba(115,115,115,0.28)] group-hover/history-row:text-[rgba(115,115,115,0.54)] group-focus-within/history-row:text-[rgba(115,115,115,0.54)]'
      )}>
        {indexLabel}
      </span>
      <div
        className={cn(
          "history-entry group/history-entry relative min-h-9 min-w-0 flex-auto rounded-[18px] border border-[var(--warm-gray)] bg-tab-card text-tab-ink [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:border-[var(--accent-amber)] focus-within:bg-tab-card focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
          entry.current && 'is-current current-active-history-entry border-transparent bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
          !entry.current && 'group-hover/history-row:border-[var(--accent-amber)] group-hover/history-row:bg-tab-card group-hover/history-row:after:opacity-100',
          isActiveEntry && 'is-active',
          activeInOtherWindow && 'active-in-other-window-history-entry border-[rgba(115,115,115,0.2)] bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)] group-hover/history-row:bg-[rgba(82,82,82,0.18)] [--history-entry-fade-bg:color-mix(in_srgb,var(--card-bg)_82%,rgb(82_82_82))]',
          entry.previousTarget && 'is-previous-target',
          entry.nextTarget && 'is-next-target',
          isWorkingSetPriority && 'history-entry-working-set-match',
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
          alignOffset={0}
          anchor={getHistoryTitleTooltipAnchor}
          anchorToCursor={false}
          content={titleTooltipContent}
          className="history-entry-title-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word]"
          instant
          sideOffset={0}
          style={titleTooltipStyle}
        >
          <div
            role="button"
            tabIndex={entry.exists ? 0 : -1}
            aria-disabled={!entry.exists}
            className="history-entry-main flex min-h-8.5 w-full cursor-default items-center gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none"
            onClick={entry.exists ? onFocusEntry : undefined}
            onKeyDown={onEntryKeyDown}
          >
            <span className={cn('history-entry-favicon-frame group/history-favicon-frame relative grid size-4 flex-none place-items-center', !faviconUrl && !isWorkingSetExtra && !canCloseEntry && 'invisible')}>
              <span
                className={cn(
                  'history-entry-favicon-content grid h-full w-full place-items-center',
                  canCloseEntry && 'group-hover/history-favicon-frame:opacity-0'
                )}
                aria-hidden="true"
              >
                {faviconUrl ? <img className="block h-full w-full object-contain" src={faviconUrl} alt="" /> : isWorkingSetExtra ? <DefaultFavicon /> : null}
              </span>
              {canCloseEntry && (
                <button
                  type="button"
                  className="history-entry-close history-entry-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-[3] inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 leading-0 outline-none group-hover/history-favicon-frame:pointer-events-auto group-hover/history-favicon-frame:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:text-tab-ink hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--card-bg)] focus-visible:text-tab-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]"
                  aria-label={`Close ${entryLabel}`}
                  onClick={onCloseEntry}
                >
                  <X className="size-[15px]" strokeWidth={2.5} aria-hidden="true" />
                </button>
              )}
            </span>
            <span className="flex min-w-0 flex-auto items-baseline gap-1.5">
              <span className="history-entry-title min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-tab-ink [font-size:inherit] [font-weight:inherit] [&.history-entry-title-truncated]:text-clip [&.history-entry-title-truncated]:[mask-image:linear-gradient(to_right,black_0,black_calc(100%_-_14px),transparent)]" ref={titleRef}>
                {bionicTitleTextNodes(entry.title, 'history-entry-title')}
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
          </div>
        </TooltipAnchor>
      </div>
    </div>
  )
}

export function TabHistoryPanel({ snapshot, workingSet = null, onSnapshotChange, onHoverUrlChange, activeHoverUrl = '', activeHoverUrls = EMPTY_HOVER_URLS, activeHoverSource = null, onTabsChange }: TabHistoryPanelProps) {
  const entries = snapshot?.entries || []
  const displayEntries = entries.slice().reverse()
  const workingSetLimit = workingSet?.defaultLimit || 0
  const visibleWorkingSetItems = workingSetLimit > 0 ? (workingSet?.items || []).slice(0, workingSetLimit) : []
  const workingSetMatches = makeWorkingSetMatches(visibleWorkingSetItems)
  const historyRows = displayEntries.map((entry, index) => ({
    entry,
    index,
    workingSetMatch: workingSetMatches.get(historyEntryWorkingSetKey(entry)) || null
  }))
  const historyWorkingSetKeys = new Set(displayEntries.flatMap((entry) => {
    const key = historyEntryWorkingSetKey(entry)
    return key ? [key] : []
  }))
  const extraWorkingSetItems = visibleWorkingSetItems.filter((item) => !historyWorkingSetKeys.has(item.key))
  const hasWorkingSetSignals = visibleWorkingSetItems.length > 0
  const hasRows = displayEntries.length > 0 || extraWorkingSetItems.length > 0

  return (
    <section
      className="tab-history-panel sticky top-0 col-start-1 flex h-screen max-h-screen min-w-0 flex-col pl-[var(--dashboard-history-edge-gutter)] max-[900px]:static max-[900px]:ml-0 max-[900px]:mr-[var(--dashboard-scrollbar-inset)] max-[900px]:h-auto max-[900px]:max-h-[260px] max-[900px]:border-b max-[900px]:border-[var(--warm-gray)] max-[900px]:pr-0 max-[900px]:pb-0 max-[900px]:[.dashboard-shell.has-history_&]:[grid-column:1]"
      aria-label="Activation history"
    >
      <div className="history-entry-list flex min-h-0 min-w-0 flex-auto flex-col gap-1.5 overflow-y-auto pt-3 pr-3.5 pb-7.5 [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-0.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(115,115,115,0.28)] [&::-webkit-scrollbar-thumb:hover]:bg-[rgba(115,115,115,0.4)] max-[900px]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))] max-[900px]:[&::-webkit-scrollbar]:w-1">
        {hasRows ? (
          <>
            {historyRows.map(({ entry, index, workingSetMatch }) => (
              <HistoryEntry
                key={`${entry.windowId}:${entry.tabId}:${entry.index}`}
                entry={entry}
                indexLabel={historyEntryIndexLabel(entry, snapshot, index + 1)}
                snapshot={snapshot}
                workingSetMatch={workingSetMatch}
                dimmed={shouldDimHistoryEntry(entry, workingSetMatch, hasWorkingSetSignals)}
                onSnapshotChange={onSnapshotChange}
                onHoverUrlChange={onHoverUrlChange}
                activeHoverUrl={activeHoverUrl}
                activeHoverUrls={activeHoverUrls}
                activeHoverSource={activeHoverSource}
                onTabsChange={onTabsChange}
              />
            ))}
            {extraWorkingSetItems.length > 0 && (
              <div className="history-working-set-extra-list flex min-w-0 flex-col gap-1.5 border-t border-[rgba(115,115,115,0.14)] pt-1.5">
                {extraWorkingSetItems.map((item) => (
                  <HistoryEntry
                    key={`working-set:${item.key}`}
                    entry={historyEntryFromWorkingSetItem(item)}
                    indexLabel={<span className="block size-1.5 rounded-full bg-[var(--accent-amber)]" aria-hidden="true" />}
                    snapshot={snapshot}
                    workingSetMatch={{ item }}
                    workingSetItem={item}
                    onSnapshotChange={onSnapshotChange}
                    onHoverUrlChange={onHoverUrlChange}
                    activeHoverUrl={activeHoverUrl}
                    activeHoverUrls={activeHoverUrls}
                    activeHoverSource={activeHoverSource}
                    onTabsChange={onTabsChange}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex min-h-13.5 items-center text-[12px] text-tab-muted">No activation history yet.</div>
        )}
      </div>
    </section>
  )
}
