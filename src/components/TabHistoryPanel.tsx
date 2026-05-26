import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, SetStateAction, WheelEvent } from 'react'
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
import { cn } from '@/lib/utils'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { TabHistoryEntry, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'

let historyTitleResizeObserver: ResizeObserver | null = null
const HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX = 12
const HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX = 8
const HISTORY_ENTRY_EXPANDED_WIDTH_SEARCH_STEPS = 12
const HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX = 1
const HISTORY_ENTRY_EXPANDED_CLOSE_DELAY_MS = 160
const HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME = 'history-entry-expanded-lines block min-w-0 max-w-full'
const HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME = 'history-entry-expanded-line block min-w-0 max-w-full whitespace-nowrap'
const HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
const HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
const DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY: HistoryEntryExpansionGeometry = {
  bottom: 0,
  left: 0,
  lineHtml: [],
  maxWidth: 0,
  titleWidth: 0,
  top: 0,
  viewportConstrained: false,
  width: 0,
  y: 'down'
}
const DEFAULT_HISTORY_ENTRY_SLOT_SIZE: HistoryEntrySlotSize = { height: 0, width: 0 }
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
const HISTORY_TITLE_EXPANDED_LAYOUT_CACHE_LIMIT = 240
const historyTitleExpandedLayoutCache = new Map<string, HistoryTitleExpandedLayoutMetrics>()
let activeExpandedHistoryEntryId: string | null = null
const expandedHistoryEntrySubscribers = new Set<(activeId: string | null) => void>()

function setActiveExpandedHistoryEntry(id: string | null) {
  if (activeExpandedHistoryEntryId === id) return
  activeExpandedHistoryEntryId = id
  for (const subscriber of expandedHistoryEntrySubscribers) subscriber(activeExpandedHistoryEntryId)
}

function subscribeToExpandedHistoryEntry(subscriber: (activeId: string | null) => void) {
  expandedHistoryEntrySubscribers.add(subscriber)
  return () => {
    expandedHistoryEntrySubscribers.delete(subscriber)
  }
}

type HistoryTitleMetrics = {
  contentWidth: number
  expandedLineHtml: string[]
  expandedTextWidth: number
  expandedViewportConstrained: boolean
  isTruncated: boolean
  visibleLineCount: number
  width: number
}
type HistoryTitleExpandedLayoutMetrics = Omit<HistoryTitleMetrics, 'isTruncated'>

type HistoryTitleExpandedDomPosition = {
  node: Text
  offset: number
}

type HistoryEntryExpansionGeometry = {
  bottom: number
  left: number
  lineHtml: string[]
  maxWidth: number
  top: number
  titleWidth: number
  viewportConstrained: boolean
  width: number
  y: 'down' | 'up'
}

type HistoryEntrySlotSize = {
  height: number
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
  return (
    titleEl.scrollHeight - titleEl.clientHeight > 1 ||
    titleEl.scrollWidth - titleEl.clientWidth > 1
  )
}

function getHistoryTitleWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0
  return Math.round(titleEl.getBoundingClientRect().width * 100) / 100
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

function historyTitleExpandedLineHtmlEquals(left: readonly string[], right: readonly string[]) {
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

function getHistoryTitleExpandedLineHtml(titleEl: HTMLElement | null) {
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
  const lineStarts: HistoryTitleExpandedDomPosition[] = []
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

function historyTitleExpandedLineContentOverflows(line: HTMLElement) {
  if (line.scrollWidth - line.clientWidth > HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX) return true

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
          rect.right - lineRect.right > HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX
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

function historyTitleExpandedLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  const lastIndex = lineHtml.length - 1
  return `<span class="${HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME}">${lineHtml.map((html, index) => (
    `<span class="${index === lastIndex ? HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME : viewportConstrained ? HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME : HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME}">${html}</span>`
  )).join('')}</span>`
}

function historyTitleExpandedLineNodesFromHtml(html: string, keyPrefix: string): ReactNode {
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

function historyTitleExpandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const styles = window.getComputedStyle(measureEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (!lineHeight || !Number.isFinite(lineHeight)) return true
  const fixedLineOverflows = Array.from(measureEl.querySelectorAll<HTMLElement>('.history-entry-expanded-line:not(.history-entry-expanded-line-tail)'))
    .some(historyTitleExpandedLineContentOverflows)
  return !fixedLineOverflows && measureEl.getBoundingClientRect().height <=
    targetLineCount * lineHeight + HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX
}

function createHistoryTitleExpandedMeasureElement(titleEl: HTMLElement, lineHtml: readonly string[]) {
  const ownerDocument = titleEl.ownerDocument
  if (!ownerDocument.body) return null

  const styles = window.getComputedStyle(titleEl)
  const measureEl = ownerDocument.createElement('span')
  measureEl.className = 'history-entry-title-expansion-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-tab-ink [font-family:inherit] [hyphenate-character:\'\'] [overflow-wrap:break-word]'
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
  measureEl.innerHTML = lineHtml.length > 0 ? historyTitleExpandedLineMarkup(lineHtml) : titleEl.innerHTML
  ownerDocument.body.append(measureEl)
  return measureEl
}

function getHistoryTitleExpandedTextWidth(
  titleEl: HTMLElement | null,
  lineHtml: readonly string[],
  contentWidth: number,
  availableContentWidth: number,
  visibleLineCount: number,
  visibleWidth: number
) {
  if (!titleEl) return { viewportConstrained: false, width: 0 }

  const availableWidth = Math.max(1, availableContentWidth)
  const naturalWidth = Math.max(1, contentWidth || visibleWidth)
  const maxContentWidth = Math.min(availableWidth, naturalWidth)
  const targetLineCount = Math.max(1, visibleLineCount || 1)

  const measureEl = createHistoryTitleExpandedMeasureElement(titleEl, lineHtml)
  if (!measureEl) return { viewportConstrained: false, width: Math.round(Math.min(availableWidth, Math.max(visibleWidth, naturalWidth / targetLineCount)) * 100) / 100 }

  try {
    const lowerBound = Math.min(Math.max(1, visibleWidth), maxContentWidth)
    if (historyTitleExpandedMeasureFitsLineCount(measureEl, lowerBound, targetLineCount)) {
      return { viewportConstrained: false, width: Math.round(lowerBound * 100) / 100 }
    }

    if (!historyTitleExpandedMeasureFitsLineCount(measureEl, maxContentWidth, targetLineCount)) {
      return { viewportConstrained: true, width: Math.round(maxContentWidth * 100) / 100 }
    }

    let low = lowerBound
    let high = maxContentWidth
    for (let i = 0; i < HISTORY_ENTRY_EXPANDED_WIDTH_SEARCH_STEPS; i += 1) {
      const mid = (low + high) / 2
      if (historyTitleExpandedMeasureFitsLineCount(measureEl, mid, targetLineCount)) {
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
    historyTitleExpandedLineHtmlEquals(a.expandedLineHtml, b.expandedLineHtml) &&
    Math.abs(a.expandedTextWidth - b.expandedTextWidth) < 0.1 &&
    a.expandedViewportConstrained === b.expandedViewportConstrained &&
    a.isTruncated === b.isTruncated &&
    a.visibleLineCount === b.visibleLineCount &&
    Math.abs(a.width - b.width) < 0.1
  )
}

function rememberHistoryTitleExpandedLayout(key: string, metrics: HistoryTitleExpandedLayoutMetrics) {
  historyTitleExpandedLayoutCache.set(key, metrics)
  if (historyTitleExpandedLayoutCache.size <= HISTORY_TITLE_EXPANDED_LAYOUT_CACHE_LIMIT) return
  const oldestKey = historyTitleExpandedLayoutCache.keys().next().value
  if (oldestKey) historyTitleExpandedLayoutCache.delete(oldestKey)
}

function historyTitleExpandedLayoutCacheKey(titleEl: HTMLElement, availableContentWidth: number) {
  const win = titleEl.ownerDocument.defaultView
  const styles = win?.getComputedStyle(titleEl)
  const rect = titleEl.getBoundingClientRect()
  return JSON.stringify([
    titleEl.innerHTML,
    Math.round(rect.left * 100) / 100,
    Math.round(rect.top * 100) / 100,
    getHistoryTitleWidth(titleEl),
    getHistoryTitleVisibleLineCount(titleEl),
    Math.round(availableContentWidth * 100) / 100,
    styles?.font || '',
    styles?.letterSpacing || '',
    styles?.lineHeight || '',
    win?.devicePixelRatio || 1
  ])
}

function syncHistoryTitleFade(titleEl: HTMLElement | null) {
  if (!titleEl) return { contentWidth: 0, expandedLineHtml: [], expandedTextWidth: 0, expandedViewportConstrained: false, isTruncated: false, visibleLineCount: 1, width: 0 }

  const isTruncated = isHistoryTitleTruncated(titleEl)
  const visibleLineCount = getHistoryTitleVisibleLineCount(titleEl)
  const width = getHistoryTitleWidth(titleEl)
  const metrics = {
    contentWidth: 0,
    expandedLineHtml: [],
    expandedTextWidth: 0,
    expandedViewportConstrained: false,
    isTruncated,
    visibleLineCount,
    width
  }
  titleEl.classList.toggle('history-entry-title-truncated', isTruncated)
  historyTitleTruncationCallbacks.get(titleEl)?.(metrics)
  return metrics
}

function measureHistoryTitleExpandedLayout(titleEl: HTMLElement | null, availableContentWidth = Number.POSITIVE_INFINITY): HistoryTitleMetrics {
  if (!titleEl) return { contentWidth: 0, expandedLineHtml: [], expandedTextWidth: 0, expandedViewportConstrained: false, isTruncated: false, visibleLineCount: 1, width: 0 }

  const cacheKey = historyTitleExpandedLayoutCacheKey(titleEl, availableContentWidth)
  const cachedLayout = historyTitleExpandedLayoutCache.get(cacheKey)
  const isTruncated = isHistoryTitleTruncated(titleEl)
  if (cachedLayout) return { ...cachedLayout, isTruncated }

  const contentWidth = getHistoryTitleContentWidth(titleEl)
  const visibleLineCount = getHistoryTitleVisibleLineCount(titleEl)
  const width = getHistoryTitleWidth(titleEl)
  const expandedLineHtml = getHistoryTitleExpandedLineHtml(titleEl)
  const expandedMetrics = getHistoryTitleExpandedTextWidth(titleEl, expandedLineHtml, contentWidth, availableContentWidth, visibleLineCount, width)
  const layout = {
    contentWidth,
    expandedLineHtml,
    expandedTextWidth: expandedMetrics.width,
    expandedViewportConstrained: expandedMetrics.viewportConstrained,
    visibleLineCount,
    width
  }
  rememberHistoryTitleExpandedLayout(cacheKey, layout)
  return { ...layout, isTruncated }
}

function updateTitleTruncation(
  titleEl: HTMLElement | null,
  setTitleMetrics: Dispatch<SetStateAction<HistoryTitleMetrics>>
) {
  const metrics = syncHistoryTitleFade(titleEl)
  setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
}

function getHistoryEntryExpansionHorizontalInset(entryEl: HTMLElement, titleEl: HTMLElement) {
  const entryRect = entryEl.getBoundingClientRect()
  const titleRect = titleEl.getBoundingClientRect()
  return Math.max(0, titleRect.left - entryRect.left) + Math.max(0, entryRect.right - titleRect.right)
}

function getHistoryEntryExpansionGeometry(entryEl: HTMLElement | null, titleEl: HTMLElement | null): HistoryEntryExpansionGeometry {
  if (!entryEl || !titleEl || typeof window === 'undefined') return DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY

  const rect = entryEl.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
  const roomToRight = Math.max(0, viewportWidth - rect.left - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomBelow = Math.max(0, viewportHeight - rect.top - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomAbove = Math.max(0, rect.bottom - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const maxWidth = Math.max(rect.width, roomToRight)
  const horizontalInset = getHistoryEntryExpansionHorizontalInset(entryEl, titleEl)
  const maxContentWidth = Math.max(1, maxWidth - horizontalInset)
  const metrics = measureHistoryTitleExpandedLayout(titleEl, maxContentWidth)
  const expandedContentWidth = Math.min(
    maxContentWidth,
    Math.max(metrics.width, metrics.expandedTextWidth + HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX)
  )

  return {
    bottom: Math.round((viewportHeight - rect.bottom) * 100) / 100,
    left: Math.round(rect.left * 100) / 100,
    lineHtml: metrics.expandedLineHtml,
    maxWidth,
    top: Math.round(rect.top * 100) / 100,
    titleWidth: expandedContentWidth,
    viewportConstrained: metrics.expandedViewportConstrained,
    width: Math.min(maxWidth, Math.max(rect.width, horizontalInset + expandedContentWidth)),
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up'
  }
}

function roundedHistoryEntrySlotSize(element: HTMLElement | null): HistoryEntrySlotSize {
  if (!element) return DEFAULT_HISTORY_ENTRY_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100
  }
}

function historyEntrySlotSizeEqual(left: HistoryEntrySlotSize, right: HistoryEntrySlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function historyEntryExpansionGeometryEqual(left: HistoryEntryExpansionGeometry, right: HistoryEntryExpansionGeometry) {
  return (
    historyTitleExpandedLineHtmlEquals(left.lineHtml, right.lineHtml) &&
    left.y === right.y &&
    left.viewportConstrained === right.viewportConstrained &&
    Math.abs(left.bottom - right.bottom) < 0.1 &&
    Math.abs(left.left - right.left) < 0.1 &&
    Math.abs(left.maxWidth - right.maxWidth) < 0.1 &&
    Math.abs(left.top - right.top) < 0.1 &&
    Math.abs(left.titleWidth - right.titleWidth) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
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
  const entryExpansionId = useId()
  const entrySlotRef = useRef<HTMLDivElement | null>(null)
  const entryRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const titleExpandedRef = useRef(false)
  const titleExpansionCloseTimerRef = useRef<number | null>(null)
  const [titleMetrics, setTitleMetrics] = useState<HistoryTitleMetrics>({
    contentWidth: 0,
    expandedLineHtml: [],
    expandedTextWidth: 0,
    expandedViewportConstrained: false,
    isTruncated: false,
    visibleLineCount: 1,
    width: 0
  })
  const [titleExpanded, setTitleExpandedState] = useState(false)
  const [entrySlotSize, setEntrySlotSize] = useState(DEFAULT_HISTORY_ENTRY_SLOT_SIZE)
  const [entryExpansionGeometry, setEntryExpansionGeometry] = useState(DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY)

  function setTitleExpanded(nextExpanded: boolean) {
    titleExpandedRef.current = nextExpanded
    setTitleExpandedState(nextExpanded)
  }

  function updateHistoryEntryExpansionMeasurements() {
    const entryEl = entryRef.current
    const titleEl = titleRef.current
    const nextSize = roundedHistoryEntrySlotSize(entryEl)
    const nextGeometry = getHistoryEntryExpansionGeometry(entryEl, titleEl)
    setEntrySlotSize((current) => historyEntrySlotSizeEqual(current, nextSize) ? current : nextSize)
    setEntryExpansionGeometry((current) => historyEntryExpansionGeometryEqual(current, nextGeometry) ? current : nextGeometry)
  }

  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const frameId = requestAnimationFrame(() => {
      if (titleExpandedRef.current) return
      updateTitleTruncation(titleEl, setTitleMetrics)
    })
    return () => cancelAnimationFrame(frameId)
  })

  useLayoutEffect(() => {
    const entryEl = entryRef.current
    if (!entryEl) return

    if (!titleExpandedRef.current) updateHistoryEntryExpansionMeasurements()
    if (typeof ResizeObserver !== 'function') return

    const observer = new ResizeObserver(() => {
      if (!titleExpandedRef.current) updateHistoryEntryExpansionMeasurements()
    })
    observer.observe(entryEl)
    return () => observer.disconnect()
  })

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    let disposed = false
    const observer = getHistoryTitleResizeObserver()
    historyTitleTruncationCallbacks.set(titleEl, (metrics) => {
      if (disposed) return
      if (titleExpandedRef.current) return
      setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
    })
    observer?.observe(titleEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (disposed) return
      if (titleExpandedRef.current) return
      updateTitleTruncation(titleEl, setTitleMetrics)
      updateHistoryEntryExpansionMeasurements()
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

  useEffect(() => subscribeToExpandedHistoryEntry((activeId) => {
    if (activeId === entryExpansionId) return
    if (!titleExpandedRef.current) return
    setTitleExpanded(false)
  }), [entryExpansionId])

  useEffect(() => () => {
    if (titleExpansionCloseTimerRef.current !== null) {
      window.clearTimeout(titleExpansionCloseTimerRef.current)
    }
    if (activeExpandedHistoryEntryId === entryExpansionId) {
      setActiveExpandedHistoryEntry(null)
    }
  }, [entryExpansionId])

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

  function clearTitleExpansionCloseTimer() {
    if (titleExpansionCloseTimerRef.current === null) return
    window.clearTimeout(titleExpansionCloseTimerRef.current)
    titleExpansionCloseTimerRef.current = null
  }

  function openTitleExpansion() {
    const titleEl = titleRef.current
    if (!isHistoryTitleTruncated(titleEl)) return
    clearTitleExpansionCloseTimer()
    updateTitleTruncation(titleEl, setTitleMetrics)
    updateHistoryEntryExpansionMeasurements()
    setActiveExpandedHistoryEntry(entryExpansionId)
    setTitleExpanded(true)
  }

  function closeTitleExpansion({ delayed = true } = {}) {
    clearTitleExpansionCloseTimer()
    if (!delayed) {
      if (activeExpandedHistoryEntryId === entryExpansionId) setActiveExpandedHistoryEntry(null)
      setTitleExpanded(false)
      return
    }
    titleExpansionCloseTimerRef.current = window.setTimeout(() => {
      titleExpansionCloseTimerRef.current = null
      if (activeExpandedHistoryEntryId === entryExpansionId) setActiveExpandedHistoryEntry(null)
      setTitleExpanded(false)
    }, HISTORY_ENTRY_EXPANDED_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    if (!titleExpanded) return
    const closeNow = () => {
      clearTitleExpansionCloseTimer()
      if (activeExpandedHistoryEntryId === entryExpansionId) setActiveExpandedHistoryEntry(null)
      setTitleExpanded(false)
    }
    const closeOnPointerMove = (event: globalThis.PointerEvent) => {
      const slotRect = entrySlotRef.current?.getBoundingClientRect()
      if (!slotRect) return
      const insideOriginalSlot =
        event.clientX >= slotRect.left &&
        event.clientX <= slotRect.right &&
        event.clientY >= slotRect.top &&
        event.clientY <= slotRect.bottom
      if (!insideOriginalSlot) closeNow()
    }
    const closeOnVisibilityChange = () => {
      if (document.hidden) closeNow()
    }
    window.addEventListener('blur', closeNow)
    window.addEventListener('pointermove', closeOnPointerMove, true)
    window.addEventListener('scroll', closeNow, true)
    document.addEventListener('visibilitychange', closeOnVisibilityChange)
    return () => {
      window.removeEventListener('blur', closeNow)
      window.removeEventListener('pointermove', closeOnPointerMove, true)
      window.removeEventListener('scroll', closeNow, true)
      document.removeEventListener('visibilitychange', closeOnVisibilityChange)
    }
  }, [entryExpansionId, titleExpanded])

  function onHistoryEntryPointerEnter() {
    openTitleExpansion()
  }

  function onHistoryEntryPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (titleExpandedRef.current) return
    const slotRect = entrySlotRef.current?.getBoundingClientRect()
    if (
      slotRect &&
      (e.clientX < slotRect.left ||
        e.clientX > slotRect.right ||
        e.clientY < slotRect.top ||
        e.clientY > slotRect.bottom)
    ) {
      return
    }
    openTitleExpansion()
  }

  function onHistoryEntryPointerLeave(e: PointerEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeTitleExpansion()
  }

  function onHistoryEntryWheel(e: WheelEvent<HTMLDivElement>) {
    if (!titleExpandedRef.current || e.deltaY === 0) return
    const historyList = entrySlotRef.current?.closest<HTMLElement>('.history-entry-list')
    if (!historyList) return
    const maxScrollTop = Math.max(0, historyList.scrollHeight - historyList.clientHeight)
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, historyList.scrollTop + e.deltaY))
    e.preventDefault()
    e.stopPropagation()
    if (nextScrollTop !== historyList.scrollTop) historyList.scrollTop = nextScrollTop
    closeTitleExpansion({ delayed: false })
  }

  function onHistoryEntryFocus(e: FocusEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) openTitleExpansion()
  }

  function onHistoryEntryBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeTitleExpansion({ delayed: false })
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
  const entrySlotStyle = titleExpanded && entrySlotSize.width > 0 && entrySlotSize.height > 0 ? {
    height: `${entrySlotSize.height}px`,
    width: `${entrySlotSize.width}px`
  } as CSSProperties : undefined
  const entryExpandedMaxWidth = entryExpansionGeometry.maxWidth > 0 ? `${entryExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const entryExpandedWidth = entryExpansionGeometry.width > 0 ? `${entryExpansionGeometry.width}px` : entryExpandedMaxWidth
  const entryExpandedTitleWidth = entryExpansionGeometry.titleWidth > 0 ? `${entryExpansionGeometry.titleWidth}px` : `${Math.max(1, titleMetrics.width)}px`
  const entryStyle = titleExpanded ? {
    '--history-entry-expanded-max-width': entryExpandedMaxWidth,
    '--history-entry-expanded-title-width': entryExpandedTitleWidth,
    '--history-entry-expanded-width': entryExpandedWidth,
    bottom: entryExpansionGeometry.y === 'up' ? `${entryExpansionGeometry.bottom}px` : undefined,
    left: `${entryExpansionGeometry.left}px`,
    maxWidth: entryExpandedMaxWidth,
    top: entryExpansionGeometry.y === 'down' ? `${entryExpansionGeometry.top}px` : undefined,
    width: entryExpandedWidth
  } as CSSProperties : undefined
  function historyTitleExpandedLinesNode() {
    const lastIndex = entryExpansionGeometry.lineHtml.length - 1
    return (
      <span className={HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME}>
        {entryExpansionGeometry.lineHtml.map((html, index) => (
          <span
            key={`${index}:${html}`}
            className={index === lastIndex ? HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME : entryExpansionGeometry.viewportConstrained ? HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME : HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME}
          >
            {historyTitleExpandedLineNodesFromHtml(html, `history-title-line-${index}`)}
          </span>
        ))}
      </span>
    )
  }
  function historyTitleContentNode() {
    if (titleExpanded && entryExpansionGeometry.lineHtml.length > 0) return historyTitleExpandedLinesNode()
    return bionicTitleTextNodes(entry.title, 'history-entry-title')
  }
  const titleExpansionTriggerElement = (
    <span
      className={cn(
        'history-entry-title-expansion-hit-area -my-[5px] flex min-w-0 flex-auto py-[5px]',
        dimmed && 'history-entry-low-score-content opacity-60 group-hover/history-row:opacity-100 group-focus-within/history-row:opacity-100 group-[.history-entry-row-expanded-open]/history-row:opacity-100'
      )}
    >
      <span className="flex min-w-0 flex-auto items-start gap-1.5">
        <span
          className={cn(
            "history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] text-tab-ink [font-size:inherit] [font-weight:inherit] [hyphenate-character:''] [overflow-wrap:break-word] [&.history-entry-title-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(100%_-_60px),rgba(0,0,0,0.35)_calc(100%_-_20px),transparent)]",
            titleExpanded && '!max-h-none !max-w-none !flex-none !overflow-visible ![mask-image:none] w-[var(--history-entry-expanded-title-width)] whitespace-normal [overflow-wrap:break-word]'
          )}
          ref={titleRef}
        >
          {historyTitleContentNode()}
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
        titleExpanded && 'history-entry-row-expanded-open'
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
          dimmed && 'text-[rgba(115,115,115,0.28)] group-hover/history-row:text-[rgba(115,115,115,0.54)] group-focus-within/history-row:text-[rgba(115,115,115,0.54)] group-[.history-entry-row-expanded-open]/history-row:text-[rgba(115,115,115,0.54)]'
        )}
      >
        {indexLabel}
      </span>
      <div
        className="history-entry-slot relative min-w-0 flex-auto"
        style={entrySlotStyle}
        ref={entrySlotRef}
      >
        <div
          data-expanded={titleExpanded ? 'true' : undefined}
          data-current={entry.current ? 'true' : undefined}
          data-active={isActiveEntry ? 'true' : undefined}
          data-active-in-other-window={activeInOtherWindow ? 'true' : undefined}
          data-previous-target={entry.previousTarget ? 'true' : undefined}
          data-next-target={entry.nextTarget ? 'true' : undefined}
          data-working-set-priority={isWorkingSetPriority ? 'true' : undefined}
          className={cn(
            "history-entry group/history-entry relative min-h-9 min-w-0 flex-auto rounded-[10px] border-0 bg-transparent text-tab-ink [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:bg-[rgba(82,82,82,0.13)] focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
            titleExpanded && 'history-entry-expanded-open',
            titleExpanded && 'history-entry-expanded fixed z-30 min-w-0 max-w-[var(--history-entry-expanded-max-width)] cursor-default select-none !overflow-visible !transition-none [width:var(--history-entry-expanded-width)] shadow-[0_4px_14px_rgba(10,10,10,0.07)]',
            entry.current && 'bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
            !entry.current && 'group-hover/history-row:bg-[rgba(82,82,82,0.13)] group-hover/history-row:after:opacity-100 [&.history-entry-expanded-open]:bg-[color-mix(in_srgb,var(--card-bg)_87%,rgb(82_82_82))] [&.history-entry-expanded-open]:after:opacity-100',
            activeInOtherWindow && 'bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)] group-hover/history-row:bg-[rgba(82,82,82,0.18)] [&.history-entry-expanded-open]:bg-[color-mix(in_srgb,var(--card-bg)_82%,rgb(82_82_82))] [--history-entry-fade-bg:color-mix(in_srgb,var(--card-bg)_82%,rgb(82_82_82))]',
            hoverMatched && 'history-entry-hover-match'
          )}
          style={entryStyle}
          ref={entryRef}
          onPointerEnter={onHistoryEntryPointerEnter}
          onPointerMove={onHistoryEntryPointerMove}
          onPointerLeave={onHistoryEntryPointerLeave}
          onWheel={onHistoryEntryWheel}
          onFocus={onHistoryEntryFocus}
          onBlur={onHistoryEntryBlur}
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
            {titleExpansionTriggerElement}
          </div>
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
      className="tab-history-panel sticky top-0 z-30 col-start-1 flex h-screen max-h-screen min-w-0 flex-col pl-[var(--dashboard-history-edge-gutter)] max-[900px]:static max-[900px]:ml-0 max-[900px]:mr-[var(--dashboard-scrollbar-inset)] max-[900px]:h-auto max-[900px]:max-h-[260px] max-[900px]:border-b max-[900px]:border-[var(--warm-gray)] max-[900px]:pr-0 max-[900px]:pb-0 max-[900px]:[.dashboard-shell.has-history_&]:[grid-column:1]"
      aria-label="Activation history"
    >
      <div className="history-entry-list flex min-h-0 min-w-0 flex-auto flex-col gap-0.75 overflow-y-auto pt-3 pr-3.5 pb-7.5 [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-0.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(115,115,115,0.28)] [&::-webkit-scrollbar-thumb:hover]:bg-[rgba(115,115,115,0.4)] max-[900px]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))] max-[900px]:[&::-webkit-scrollbar]:w-1">
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
              <div data-tabout-part="working-set-extra-list" className="flex min-w-0 flex-col gap-0.75 border-t border-[rgba(115,115,115,0.14)] pt-0.75">
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
