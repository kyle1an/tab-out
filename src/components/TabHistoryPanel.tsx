import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, KeyboardEvent, MouseEvent, ReactNode, SetStateAction } from 'react'
import { X } from 'lucide-react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntry } from '../extension/tab-history.js'
import { focusWorkingSetItem } from '../extension/working-set-client.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { pageIdentityForWorkingSet } from '../extension/working-set.js'
import { unwrapSuspenderUrl } from '../extension/suspender.js'
import { markClosure } from '../extension/undo.js'
import { showToast } from '../extension/toast.js'
import { DefaultFavicon } from './DefaultFavicon'
import { bionicTitleTextNodes } from './bionic-title-text'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { TabHistoryEntry, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'

let historyTitleResizeObserver: ResizeObserver | null = null
const HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX = 6
const HISTORY_TITLE_TOOLTIP_TEXT_RIGHT_INSET_PX = 8
const HISTORY_TITLE_TOOLTIP_HORIZONTAL_PADDING_PX =
  HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX + HISTORY_TITLE_TOOLTIP_TEXT_RIGHT_INSET_PX
const HISTORY_TITLE_TOOLTIP_TEXT_TOP_INSET_PX = 4
const HISTORY_TITLE_TOOLTIP_SUBPIXEL_TOLERANCE_PX = 0.01
const HISTORY_TITLE_TOOLTIP_LINE_TOLERANCE_PX = 1
const HISTORY_TITLE_TOOLTIP_WIDTH_SEARCH_STEPS = 12
const HISTORY_TITLE_TOOLTIP_LINES_CLASS_NAME = 'history-entry-title-tooltip-lines block min-w-0 max-w-full'
const HISTORY_TITLE_TOOLTIP_LINE_CLASS_NAME = 'history-entry-title-tooltip-line block min-w-0 max-w-full whitespace-nowrap'
const HISTORY_TITLE_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME = 'history-entry-title-tooltip-line history-entry-title-tooltip-line-constrained block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
const HISTORY_TITLE_TOOLTIP_TAIL_LINE_CLASS_NAME = 'history-entry-title-tooltip-line history-entry-title-tooltip-line-tail block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
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

type HistoryTitleTooltipSubpixelOffset = {
  x: number
  y: number
}

type HistoryTitleMetrics = {
  contentWidth: number
  isTruncated: boolean
  left: number
  tooltipLineHtml: string[]
  tooltipSubpixelOffset: HistoryTitleTooltipSubpixelOffset
  tooltipTextWidth: number
  tooltipViewportConstrained: boolean
  visibleLineCount: number
  width: number
}

type HistoryTitleTooltipDomPosition = {
  node: Text
  offset: number
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
  return (
    titleEl.scrollHeight - titleEl.clientHeight > 1 ||
    titleEl.scrollWidth - titleEl.clientWidth > 1
  )
}

function getHistoryTitleWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0
  return Math.round(titleEl.getBoundingClientRect().width * 100) / 100
}

function roundHistoryTitleTooltipToDevicePixel(
  value: number,
  win: Window | null = typeof window === 'undefined' ? null : window
) {
  const scale = win?.devicePixelRatio || 1
  return Math.round(value * scale) / scale
}

function getHistoryTitleTooltipSubpixelOffset(titleEl: HTMLElement | null): HistoryTitleTooltipSubpixelOffset {
  if (!titleEl) return { x: 0, y: 0 }

  const rect = titleEl.getBoundingClientRect()
  const win = titleEl.ownerDocument.defaultView || (typeof window === 'undefined' ? null : window)
  const left = rect.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX
  const top = rect.top - HISTORY_TITLE_TOOLTIP_TEXT_TOP_INSET_PX

  return {
    x: left - roundHistoryTitleTooltipToDevicePixel(left, win),
    y: top - roundHistoryTitleTooltipToDevicePixel(top, win)
  }
}

function historyTitleTooltipSubpixelOffsetsEqual(
  left: HistoryTitleTooltipSubpixelOffset,
  right: HistoryTitleTooltipSubpixelOffset
) {
  return (
    Math.abs(left.x - right.x) < HISTORY_TITLE_TOOLTIP_SUBPIXEL_TOLERANCE_PX &&
    Math.abs(left.y - right.y) < HISTORY_TITLE_TOOLTIP_SUBPIXEL_TOLERANCE_PX
  )
}

function getHistoryTitleVisibleLineCount(titleEl: HTMLElement | null) {
  if (!titleEl) return 1

  const styles = window.getComputedStyle(titleEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  const height = titleEl.getBoundingClientRect().height
  if (!lineHeight || !Number.isFinite(lineHeight)) return 1
  return Math.max(1, Math.round(height / lineHeight))
}

function getHistoryTitleContentWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0

  const ownerDocument = titleEl.ownerDocument
  if (!ownerDocument.body) return 0

  const styles = window.getComputedStyle(titleEl)
  const clone = titleEl.cloneNode(true) as HTMLElement
  clone.classList.remove('history-entry-title-truncated')
  Object.assign(clone.style, {
    display: 'inline-block',
    font: styles.font,
    left: '0',
    letterSpacing: styles.letterSpacing,
    lineHeight: styles.lineHeight,
    maxHeight: 'none',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'nowrap',
    width: 'max-content'
  })
  clone.style.setProperty('-webkit-mask-image', 'none')
  clone.style.setProperty('mask-image', 'none')
  ownerDocument.body.append(clone)
  const width = Math.round(clone.getBoundingClientRect().width * 100) / 100
  clone.remove()
  return width
}

function historyTitleTooltipLineHtmlEquals(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

function historyTitlePaintedRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  return rects[rects.length - 1] || null
}

function historyTitleFragmentHtml(document: Document, fragment: DocumentFragment) {
  const container = document.createElement('span')
  container.append(fragment)
  return container.innerHTML
}

function getHistoryTitleTooltipLineHtml(titleEl: HTMLElement | null) {
  if (!titleEl || typeof document === 'undefined') return []

  const visibleLineCount = getHistoryTitleVisibleLineCount(titleEl)
  if (visibleLineCount <= 1) return []

  const ownerDocument = titleEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const titleRect = titleEl.getBoundingClientRect()
  const styles = win.getComputedStyle(titleEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (titleRect.height <= 0 || !lineHeight || !Number.isFinite(lineHeight)) return []

  const walker = ownerDocument.createTreeWalker(
    titleEl,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  const range = ownerDocument.createRange()
  const lineStarts: HistoryTitleTooltipDomPosition[] = []
  let lastLineIndex = -1

  while (lineStarts.length < visibleLineCount) {
    const node = walker.nextNode()
    if (!(node instanceof win.Text)) break

    const text = node.data
    for (let offset = 0; offset < text.length && lineStarts.length < visibleLineCount; offset += 1) {
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      const rect = historyTitlePaintedRangeRect(range)
      if (!rect) continue

      const lineIndex = Math.max(0, Math.round((rect.top - titleRect.top) / lineHeight))
      if (lineIndex >= visibleLineCount) break
      if (lineIndex > lastLineIndex) {
        lineStarts.push({ node, offset })
        lastLineIndex = lineIndex
      }
    }
  }

  range.detach()
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    lineRange.setStart(start.node, start.offset)
    const next = lineStarts[index + 1]
    if (next) {
      lineRange.setEnd(next.node, next.offset)
    } else {
      lineRange.selectNodeContents(titleEl)
      lineRange.setStart(start.node, start.offset)
    }
    lines.push(historyTitleFragmentHtml(ownerDocument, lineRange.cloneContents()))
    lineRange.detach()
  }

  return lines
}

function historyTitleTooltipLineContentOverflows(line: HTMLElement) {
  if (line.scrollWidth - line.clientWidth > HISTORY_TITLE_TOOLTIP_LINE_TOLERANCE_PX) return true

  const lineRect = line.getBoundingClientRect()
  const win = line.ownerDocument.defaultView
  if (!win || lineRect.width <= 0) return false

  const walker = line.ownerDocument.createTreeWalker(
    line,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  const range = line.ownerDocument.createRange()

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (
          rect.width > 0 &&
          rect.right - lineRect.right > HISTORY_TITLE_TOOLTIP_LINE_TOLERANCE_PX
        ) {
          return true
        }
      }
    }
  } finally {
    range.detach()
  }

  return false
}

function historyTitleTooltipLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  const lastIndex = lineHtml.length - 1
  return `<span class="${HISTORY_TITLE_TOOLTIP_LINES_CLASS_NAME}">${lineHtml.map((html, index) => (
    `<span class="${index === lastIndex ? HISTORY_TITLE_TOOLTIP_TAIL_LINE_CLASS_NAME : viewportConstrained ? HISTORY_TITLE_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME : HISTORY_TITLE_TOOLTIP_LINE_CLASS_NAME}">${html}</span>`
  )).join('')}</span>`
}

function historyTitleTooltipLineNodesFromHtml(html: string, keyPrefix: string): ReactNode {
  if (!html || typeof document === 'undefined') return html

  const template = document.createElement('template')
  template.innerHTML = html

  function nodeFromDom(node: ChildNode, key: string): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return null

    const element = node as Element
    const children = Array.from(element.childNodes).map((child, index) => nodeFromDom(child, `${key}-${index}`))
    const className = element.getAttribute('class') || undefined
    const ariaLabel = element.getAttribute('aria-label') || undefined

    if (element.tagName.toLowerCase() === 'span') {
      return <span key={key} className={className} aria-label={ariaLabel}>{children}</span>
    }
    if (element.tagName.toLowerCase() === 'mark') {
      return <mark key={key} className={className} aria-label={ariaLabel}>{children}</mark>
    }
    return element.textContent || ''
  }

  return Array.from(template.content.childNodes).map((node, index) => nodeFromDom(node, `${keyPrefix}-${index}`))
}

function historyTitleTooltipMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const styles = window.getComputedStyle(measureEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (!lineHeight || !Number.isFinite(lineHeight)) return true
  const fixedLineOverflows = Array.from(measureEl.querySelectorAll<HTMLElement>('.history-entry-title-tooltip-line:not(.history-entry-title-tooltip-line-tail)'))
    .some(historyTitleTooltipLineContentOverflows)
  return !fixedLineOverflows && measureEl.getBoundingClientRect().height <=
    targetLineCount * lineHeight + HISTORY_TITLE_TOOLTIP_LINE_TOLERANCE_PX
}

function createHistoryTitleTooltipMeasureElement(titleEl: HTMLElement, lineHtml: readonly string[]) {
  const ownerDocument = titleEl.ownerDocument
  if (!ownerDocument.body) return null

  const styles = window.getComputedStyle(titleEl)
  const measureEl = ownerDocument.createElement('span')
  measureEl.className = 'history-entry-title-tooltip-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-tab-ink [font-family:inherit] [hyphenate-character:\'\'] [overflow-wrap:break-word]'
  measureEl.setAttribute('aria-hidden', 'true')
  Object.assign(measureEl.style, {
    display: 'block',
    font: styles.font,
    left: '0',
    letterSpacing: styles.letterSpacing,
    lineHeight: styles.lineHeight,
    maxHeight: 'none',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'normal',
    width: 'max-content'
  })
  measureEl.style.setProperty('-webkit-mask-image', 'none')
  measureEl.style.setProperty('hyphenate-character', '')
  measureEl.style.setProperty('mask-image', 'none')
  measureEl.style.setProperty('overflow-wrap', 'break-word')
  measureEl.innerHTML = lineHtml.length > 0 ? historyTitleTooltipLineMarkup(lineHtml) : titleEl.innerHTML
  ownerDocument.body.append(measureEl)
  return measureEl
}

function getHistoryTitleTooltipTextWidth(
  titleEl: HTMLElement | null,
  lineHtml: readonly string[],
  contentWidth: number,
  left: number,
  visibleLineCount: number,
  visibleWidth: number
) {
  if (!titleEl) return { viewportConstrained: false, width: 0 }

  const popupLeft = Math.max(0, left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX)
  const availableWidth = typeof window === 'undefined'
    ? Math.max(1, contentWidth || visibleWidth)
    : Math.max(1, window.innerWidth - popupLeft - HISTORY_TITLE_TOOLTIP_HORIZONTAL_PADDING_PX - 8)
  const naturalWidth = Math.max(1, contentWidth || visibleWidth)
  const maxContentWidth = Math.min(availableWidth, naturalWidth)
  const targetLineCount = Math.max(1, visibleLineCount || 1)

  const measureEl = createHistoryTitleTooltipMeasureElement(titleEl, lineHtml)
  if (!measureEl) return { viewportConstrained: false, width: Math.round(Math.min(availableWidth, Math.max(visibleWidth, naturalWidth / targetLineCount)) * 100) / 100 }

  try {
    const lowerBound = Math.min(Math.max(1, visibleWidth), maxContentWidth)
    if (historyTitleTooltipMeasureFitsLineCount(measureEl, lowerBound, targetLineCount)) {
      return { viewportConstrained: false, width: Math.round(lowerBound * 100) / 100 }
    }

    if (!historyTitleTooltipMeasureFitsLineCount(measureEl, maxContentWidth, targetLineCount)) {
      return { viewportConstrained: true, width: Math.round(maxContentWidth * 100) / 100 }
    }

    let low = lowerBound
    let high = maxContentWidth
    for (let i = 0; i < HISTORY_TITLE_TOOLTIP_WIDTH_SEARCH_STEPS; i += 1) {
      const mid = (low + high) / 2
      if (historyTitleTooltipMeasureFitsLineCount(measureEl, mid, targetLineCount)) {
        high = mid
      } else {
        low = mid
      }
    }
    return { viewportConstrained: false, width: Math.round(high * 100) / 100 }
  } finally {
    measureEl.remove()
  }
}

function sameHistoryTitleMetrics(a: HistoryTitleMetrics, b: HistoryTitleMetrics) {
  return (
    Math.abs(a.contentWidth - b.contentWidth) < 0.1 &&
    a.isTruncated === b.isTruncated &&
    Math.abs(a.left - b.left) < 0.1 &&
    historyTitleTooltipLineHtmlEquals(a.tooltipLineHtml, b.tooltipLineHtml) &&
    historyTitleTooltipSubpixelOffsetsEqual(a.tooltipSubpixelOffset, b.tooltipSubpixelOffset) &&
    Math.abs(a.tooltipTextWidth - b.tooltipTextWidth) < 0.1 &&
    a.tooltipViewportConstrained === b.tooltipViewportConstrained &&
    a.visibleLineCount === b.visibleLineCount &&
    Math.abs(a.width - b.width) < 0.1
  )
}

function syncHistoryTitleFade(titleEl: HTMLElement | null) {
  if (!titleEl) return { contentWidth: 0, isTruncated: false, left: 0, tooltipLineHtml: [], tooltipSubpixelOffset: { x: 0, y: 0 }, tooltipTextWidth: 0, tooltipViewportConstrained: false, visibleLineCount: 1, width: 0 }

  const isTruncated = isHistoryTitleTruncated(titleEl)
  const rect = titleEl.getBoundingClientRect()
  const contentWidth = getHistoryTitleContentWidth(titleEl)
  const left = Math.round(rect.left * 100) / 100
  const visibleLineCount = getHistoryTitleVisibleLineCount(titleEl)
  const width = getHistoryTitleWidth(titleEl)
  const tooltipLineHtml = getHistoryTitleTooltipLineHtml(titleEl)
  const tooltipMetrics = getHistoryTitleTooltipTextWidth(titleEl, tooltipLineHtml, contentWidth, left, visibleLineCount, width)
  const tooltipSubpixelOffset = getHistoryTitleTooltipSubpixelOffset(titleEl)
  const metrics = {
    contentWidth,
    isTruncated,
    left,
    tooltipLineHtml,
    tooltipSubpixelOffset,
    tooltipTextWidth: tooltipMetrics.width,
    tooltipViewportConstrained: tooltipMetrics.viewportConstrained,
    visibleLineCount,
    width
  }
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
  return item ? [...new Set([...pageTargetMatchUrls(item), item.key].filter(Boolean))] : []
}

function uniqueUrls(urls: readonly string[]) {
  return [...new Set(urls.filter(Boolean))]
}

function historyEntryWorkingSetKey(entry: TabHistoryEntry) {
  return pageIdentityForWorkingSet(entry.url || entry.rawUrl || entry.displayUrl || '')
}

function isLowScoreHistoryUrl(url = '') {
  const effectiveUrl = unwrapSuspenderUrl(url || '')
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
    rawUrl: item.rawUrl,
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
    tooltipLineHtml: [],
    tooltipSubpixelOffset: { x: 0, y: 0 },
    tooltipTextWidth: 0,
    tooltipViewportConstrained: false,
    visibleLineCount: 1,
    width: 0
  })
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false)

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

  async function onHistoryTitleTooltipClick(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!entry.exists) return
    await onFocusEntry()
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
    const hoverUrl = workingSetItem ? pageTargetUrl(workingSetItem) : pageTargetUrl(entry)
    const hoverUrls = uniqueUrls([
      ...pageTargetMatchUrls(entry),
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
    ...pageTargetMatchUrls(entry),
    ...(workingSetItem ? workingSetUrls(workingSetItem) : workingSetUrls(workingSetMatch?.item))
  ])
  const hoverMatched = !!activeHoverSource && activeHoverSource !== hoverSource && (
    pageTargetMatchesHover(entry, activeHoverUrl, activeHoverUrls) ||
    matchUrls.some((url) => url === activeHoverUrl || activeHoverUrls.includes(url))
  )
  const isWorkingSetPriority = !!workingSetMatch || !!workingSetItem
  const isIndexHighlighted = !dimmed && (isActiveEntry || entry.previousTarget || entry.nextTarget || isWorkingSetPriority || hoverMatched)
  const entryLabel = entry.title || entry.displayUrl || entry.url
  const faviconUrl = entry.favIconUrl || workingSetMatch?.item.faviconUrl || workingSetItem?.faviconUrl || ''
  const titleTooltipPopupLeft = Math.max(0, titleMetrics.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX)
  const titleTooltipTargetTextWidth = titleMetrics.tooltipTextWidth || titleMetrics.width
  const titleTooltipTextWidth = Math.max(1, titleTooltipTargetTextWidth)
  const titleTooltipStyle = {
    '--history-entry-title-tooltip-text-width': `${Math.round(titleTooltipTextWidth * 100) / 100}px`,
    maxWidth: `calc(100vw - ${titleTooltipPopupLeft}px - 8px)`,
    paddingLeft: `${HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX}px`,
    paddingRight: `${HISTORY_TITLE_TOOLTIP_TEXT_RIGHT_INSET_PX}px`
  } as CSSProperties
  const titleTooltipSubpixelTransform = historyTitleTooltipSubpixelOffsetsEqual(titleMetrics.tooltipSubpixelOffset, { x: 0, y: 0 })
    ? ''
    : `translate3d(${titleMetrics.tooltipSubpixelOffset.x}px, ${titleMetrics.tooltipSubpixelOffset.y}px, 0)`
  const titleTooltipTextStyle = titleTooltipSubpixelTransform
    ? { transform: titleTooltipSubpixelTransform } as CSSProperties
    : undefined
  function getHistoryTitleTooltipAnchor() {
    const titleEl = titleRef.current
    if (!titleEl) return null

    const rect = titleEl.getBoundingClientRect()
    const viewportWidth = typeof window === 'undefined' ? rect.width : window.innerWidth
    const popupWidth = Math.min(
      Math.max(1, titleTooltipTextWidth + HISTORY_TITLE_TOOLTIP_HORIZONTAL_PADDING_PX),
      Math.max(1, viewportWidth - Math.max(0, rect.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX) - 8)
    )
    const left = rect.left - HISTORY_TITLE_TOOLTIP_TEXT_LEFT_INSET_PX
    const top = rect.top - HISTORY_TITLE_TOOLTIP_TEXT_TOP_INSET_PX

    return {
      getBoundingClientRect: () => new DOMRect(left, top, popupWidth, 0)
    }
  }
  function historyTitleTooltipLinesNode() {
    const lastIndex = titleMetrics.tooltipLineHtml.length - 1
    return (
      <span className={HISTORY_TITLE_TOOLTIP_LINES_CLASS_NAME}>
        {titleMetrics.tooltipLineHtml.map((html, index) => (
          <span
            key={`${index}:${html}`}
            className={index === lastIndex ? HISTORY_TITLE_TOOLTIP_TAIL_LINE_CLASS_NAME : titleMetrics.tooltipViewportConstrained ? HISTORY_TITLE_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME : HISTORY_TITLE_TOOLTIP_LINE_CLASS_NAME}
          >
            {historyTitleTooltipLineNodesFromHtml(html, `history-title-line-${index}`)}
          </span>
        ))}
      </span>
    )
  }
  const titleTooltipContent = titleMetrics.isTruncated && entryLabel ? (
    <span
      className="history-entry-title-tooltip block min-w-0 max-w-[calc(100vw-32px)] w-[var(--history-entry-title-tooltip-text-width)] whitespace-normal hyphens-auto break-normal text-[13px] leading-tight font-normal text-tab-ink [font-family:inherit] [hyphenate-character:''] [overflow-wrap:break-word]"
      style={titleTooltipTextStyle}
    >
      {titleMetrics.tooltipLineHtml.length > 0 ? historyTitleTooltipLinesNode() : bionicTitleTextNodes(entryLabel, 'history-entry-tooltip')}
    </span>
  ) : undefined
  const titleTooltipTriggerElement = (
    <span className="history-entry-title-tooltip-hit-area -my-[5px] flex min-w-0 flex-auto py-[5px]">
      <span className="flex min-w-0 flex-auto items-start gap-1.5">
        <span className="history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] text-tab-ink [font-size:inherit] [font-weight:inherit] [hyphenate-character:''] [overflow-wrap:break-word] [&.history-entry-title-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(100%_-_60px),rgba(0,0,0,0.35)_calc(100%_-_20px),transparent)]" ref={titleRef}>
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
    </span>
  )

  return (
    <div
      data-tabout="activation-history-entry"
      data-low-score={dimmed ? 'true' : undefined}
      data-working-set-extra={isWorkingSetExtra ? 'true' : undefined}
      className={cn(
        'history-entry-row group/history-row flex min-h-9 w-full min-w-0 flex-none items-start gap-2 font-[inherit] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-[160ms] [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.96)]',
        titleTooltipOpen && 'history-entry-row-tooltip-open',
        dimmed && 'opacity-60 hover:opacity-100 focus-within:opacity-100 [&.history-entry-row-tooltip-open]:opacity-100'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <span
        data-history-index-tone={isIndexHighlighted ? 'highlighted' : 'muted'}
        className={cn(
          'mt-[7px] inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-[rgba(115,115,115,0.42)] group-hover/history-row:text-[rgba(64,64,64,0.76)] group-focus-within/history-row:text-[rgba(64,64,64,0.76)]',
          isIndexHighlighted && 'font-semibold text-tab-ink group-hover/history-row:text-tab-ink group-focus-within/history-row:text-tab-ink',
          isWorkingSetPriority && !dimmed && 'text-[color-mix(in_srgb,var(--accent-amber)_88%,var(--ink))]',
          dimmed && 'text-[rgba(115,115,115,0.28)] group-hover/history-row:text-[rgba(115,115,115,0.54)] group-focus-within/history-row:text-[rgba(115,115,115,0.54)] group-[.history-entry-row-tooltip-open]/history-row:text-[rgba(115,115,115,0.54)]'
        )}
      >
        {indexLabel}
      </span>
      <div
        data-current={entry.current ? 'true' : undefined}
        data-active={isActiveEntry ? 'true' : undefined}
        data-active-in-other-window={activeInOtherWindow ? 'true' : undefined}
        data-previous-target={entry.previousTarget ? 'true' : undefined}
        data-next-target={entry.nextTarget ? 'true' : undefined}
        data-working-set-priority={isWorkingSetPriority ? 'true' : undefined}
        className={cn(
          "history-entry group/history-entry relative min-h-9 min-w-0 flex-auto rounded-[10px] border-0 bg-transparent text-tab-ink [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:bg-[rgba(82,82,82,0.13)] focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
          entry.current && 'bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
          titleTooltipOpen && 'history-entry-tooltip-open',
          !entry.current && 'group-hover/history-row:bg-[rgba(82,82,82,0.13)] group-hover/history-row:after:opacity-100 [&.history-entry-tooltip-open]:bg-[rgba(82,82,82,0.13)] [&.history-entry-tooltip-open]:after:opacity-100',
          activeInOtherWindow && 'bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)] group-hover/history-row:bg-[rgba(82,82,82,0.18)] [&.history-entry-tooltip-open]:bg-[rgba(82,82,82,0.18)] [--history-entry-fade-bg:color-mix(in_srgb,var(--card-bg)_82%,rgb(82_82_82))]',
          hoverMatched && 'history-entry-hover-match'
        )}
      >
        {entry.current && (
          <span
            className="active-history-entry-frame pointer-events-none absolute inset-0 z-[2] rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)] [corner-shape:squircle]"
            aria-hidden="true"
          />
        )}
        <div
          role="button"
          tabIndex={entry.exists ? 0 : -1}
          data-tabout-part="focus-button"
          aria-disabled={!entry.exists}
          className="history-entry-main flex min-h-8.5 w-full cursor-default items-start gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none"
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
                data-tabout-part="close-button"
                className="history-entry-close history-entry-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-[3] inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 leading-0 outline-none group-hover/history-favicon-frame:pointer-events-auto group-hover/history-favicon-frame:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:text-tab-ink hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--card-bg)] focus-visible:text-tab-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]"
                aria-label={`Close ${entryLabel}`}
                onClick={onCloseEntry}
              >
                <X className="size-[15px]" strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </span>
          <TooltipAnchor
            alignOffset={0}
            anchor={getHistoryTitleTooltipAnchor}
            anchorToCursor={false}
            content={titleTooltipContent}
            className="history-entry-title-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word] cursor-default select-none"
            instant
            onClick={onHistoryTitleTooltipClick}
            onOpenChange={setTitleTooltipOpen}
            sideOffset={0}
            style={titleTooltipStyle}
          >
            {titleTooltipTriggerElement}
          </TooltipAnchor>
        </div>
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
      data-tabout="activation-history"
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
              <div data-tabout-part="working-set-extra-list" className="flex min-w-0 flex-col gap-1.5 border-t border-[rgba(115,115,115,0.14)] pt-1.5">
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
