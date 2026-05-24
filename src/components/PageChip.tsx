import { cloneElement, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react'
import { X } from 'lucide-react'
import { isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import { matchValuesForFilterTerm, parseFilterQuery } from '../extension/filter-query.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { savePageTarget, removeSavedPageTarget } from '../extension/saved-page-actions.js'
import { focusExactTab, focusTab, openTabUrl } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls } from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'
import { DefaultFavicon } from './DefaultFavicon'
import { useDomainCardContext } from './DomainCardContext'
import { startPageChipCloseAnimation, waitForPageChipCloseAnimation } from './PageChipCloseAnimation'
import { TooltipAnchor } from './ui/tooltip'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { cn } from '@/lib/utils'
import { createBionicTitleTextRenderer, isUrlLikeTitle } from './bionic-title-text'
import type { InlineTextRenderer } from './bionic-title-text'
import { titleSuppressionChipHighlightClass, titleSuppressionMarkerClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData } from './types'
import type { DashboardChipEnv, DashboardSegment } from '../extension/types'

let chipTextResizeObserver: ResizeObserver | null = null
const chipTextTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: { height: number; isTruncated: boolean; maxWidth: number; width: number }) => void
>()

const PAGE_CHIP_TOOLTIP_MAX_WIDTH_OFFSET_PX = 6
const PAGE_CHIP_TOOLTIP_VIEWPORT_MARGIN_PX = 8
const PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX = 6
const PAGE_CHIP_TOOLTIP_TEXT_RIGHT_INSET_PX = 8
const PAGE_CHIP_TOOLTIP_HORIZONTAL_PADDING_PX = PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX + PAGE_CHIP_TOOLTIP_TEXT_RIGHT_INSET_PX
const PAGE_CHIP_TOOLTIP_TEXT_TOP_INSET_PX = 4
const PAGE_CHIP_TOOLTIP_SUBPIXEL_TOLERANCE_PX = 0.01
const PAGE_CHIP_TOOLTIP_WIDTH_SEARCH_STEPS = 12
const PAGE_CHIP_TOOLTIP_LINE_HEIGHT_FALLBACK_PX = 16
const PAGE_CHIP_TOOLTIP_LINE_TOLERANCE_PX = 1.5
const PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS = 80
const PAGE_CHIP_TOOLTIP_LINES_CLASS_NAME = 'page-chip-tooltip-lines block min-w-0 max-w-full'
const PAGE_CHIP_TOOLTIP_LINE_CLASS_NAME = 'page-chip-tooltip-line block min-w-0 max-w-full whitespace-nowrap'
const PAGE_CHIP_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME = 'page-chip-tooltip-line page-chip-tooltip-line-constrained block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
const PAGE_CHIP_TOOLTIP_TAIL_LINE_CLASS_NAME = 'page-chip-tooltip-line page-chip-tooltip-line-tail block min-w-0 max-w-full whitespace-normal break-normal [overflow-wrap:break-word]'
const PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0 bg-[rgba(115,115,115,0.08)] px-1 text-[12px] leading-[inherit] font-medium whitespace-nowrap text-tab-muted align-baseline [corner-shape:squircle] [-webkit-box-decoration-break:clone] [box-decoration-break:clone]'
const PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME = 'chip-strip-indicator inline-block max-w-full rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium whitespace-nowrap text-tab-muted align-baseline [corner-shape:squircle]'

interface PageChipProps {
  chip: DashboardChipData
  filter?: string
  suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
}

type ChipTextRenderMode = 'chip' | 'tooltip'
type HighlightMode = 'parsed' | 'legacy'
type RenderTitleContentOptions = {
  includePathSuffix?: boolean
}
type StopPropagationEvent = {
  stopPropagation: () => void
}
type PageChipContextMenuContentProps = {
  savedActionLabel: string
  saved: boolean
  titleText: string
  onSavedSelect: (event: StopPropagationEvent) => void | Promise<void>
  onCopyTitle: (event: StopPropagationEvent) => void | Promise<void>
}
type PageChipContextMenuTriggerElement = ReactElement<{
  className?: string
  'data-context-menu-open'?: string
}>
type PageChipContextMenuProps = PageChipContextMenuContentProps & {
  children: PageChipContextMenuTriggerElement
  onOpenChange?: (open: boolean) => void
}
type TooltipSubpixelOffset = {
  x: number
  y: number
}
type ChipTextMetrics = {
  isTruncated: boolean
  maxWidth: number
  width: number
}
type ChipLayoutState = {
  textMetrics: ChipTextMetrics
  tooltipLineHtml: string[]
  tooltipSubpixelOffset: TooltipSubpixelOffset
  tooltipViewportConstrained: boolean
  tooltipWidth: number
}
type ChipLayoutAction =
  | { type: 'textMetrics'; metrics: ChipTextMetrics }
  | {
      type: 'tooltipLayout'
      lineHtml: string[]
      subpixelOffset: TooltipSubpixelOffset
      viewportConstrained: boolean
      width: number
    }
const DEFAULT_CHIP_TEXT_METRICS: ChipTextMetrics = { isTruncated: false, maxWidth: 0, width: 0 }
const DEFAULT_CHIP_LAYOUT_STATE: ChipLayoutState = {
  textMetrics: DEFAULT_CHIP_TEXT_METRICS,
  tooltipLineHtml: [],
  tooltipSubpixelOffset: { x: 0, y: 0 },
  tooltipViewportConstrained: false,
  tooltipWidth: 0
}

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function SavedPageIcon({ saved, className }: { saved: boolean; className: string }) {
  return <span aria-hidden="true" className={cn(saved ? 'icon-[mingcute--star-fill]' : 'icon-[mingcute--star-line]', className)} />
}

function titleTextForChip(target: Pick<DashboardChipData, 'title' | 'tooltip' | 'tabUrl'>): string {
  return (target.title || target.tooltip || target.tabUrl).trim()
}

function titleTextForEnv(env: DashboardChipEnv, parent: Pick<DashboardChipData, 'title' | 'tooltip'>): string {
  return (env.title || parent.title || parent.tooltip || env.tabUrl).trim()
}

function PageChipContextMenuContent({
  savedActionLabel,
  saved,
  titleText,
  onSavedSelect,
  onCopyTitle
}: PageChipContextMenuContentProps) {
  return (
    <ContextMenuContent>
      <ContextMenuItem
        className="page-chip-save-menu-item"
        label={savedActionLabel}
        onClick={onSavedSelect}
      >
        <SavedPageIcon saved={saved} className="size-3.5" />
        <span className="min-w-0 flex-1">{savedActionLabel}</span>
      </ContextMenuItem>
      <ContextMenuItem
        className="page-chip-copy-title-menu-item"
        disabled={!titleText}
        label="Copy page title text"
        onClick={onCopyTitle}
      >
        <svg className="icon-[ooui--copy-ltr] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Copy page title text</span>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

function PageChipContextMenu({
  children,
  savedActionLabel,
  saved,
  titleText,
  onSavedSelect,
  onCopyTitle,
  onOpenChange
}: PageChipContextMenuProps) {
  const [visualOpen, setVisualOpen] = useState(false)
  const visualCloseTimerRef = useRef<number | null>(null)

  function clearVisualCloseTimer() {
    if (visualCloseTimerRef.current === null) return
    window.clearTimeout(visualCloseTimerRef.current)
    visualCloseTimerRef.current = null
  }

  useEffect(() => () => {
    if (visualCloseTimerRef.current !== null) {
      window.clearTimeout(visualCloseTimerRef.current)
    }
  }, [])

  function handleOpenChange(nextOpen: boolean) {
    clearVisualCloseTimer()
    if (nextOpen) {
      setVisualOpen(true)
    } else {
      visualCloseTimerRef.current = window.setTimeout(() => {
        visualCloseTimerRef.current = null
        setVisualOpen(false)
      }, PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS)
    }
    onOpenChange?.(nextOpen)
  }
  const trigger = visualOpen
    ? cloneElement(children, {
        className: cn(children.props.className, 'page-chip-context-menu-open'),
        'data-context-menu-open': ''
      })
    : children

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger render={trigger} />
      <PageChipContextMenuContent
        savedActionLabel={savedActionLabel}
        saved={saved}
        onSavedSelect={onSavedSelect}
        titleText={titleText}
        onCopyTitle={onCopyTitle}
      />
    </ContextMenu>
  )
}

function isTitleSuppressionSegment(segment: DashboardSegment): segment is { titleSuppression: string } {
  return typeof segment !== 'string' && 'titleSuppression' in segment
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true; label?: string } {
  return typeof segment !== 'string' && 'placeholder' in segment
}

function highlightTermsForFilter(filter: string, mode: HighlightMode): string[] {
  const query = filter.trim()
  if (!query) return []
  if (mode === 'legacy') return [query.toLowerCase()]
  return [...new Set(parseFilterQuery(query).terms.flatMap((term) => matchValuesForFilterTerm(term)))]
}

function appendTextNodes(nodes: ReactNode[], text: string, keyPrefix: string, textOffset: number, renderText: InlineTextRenderer) {
  const rendered = renderText(text, keyPrefix, textOffset)
  if (Array.isArray(rendered)) nodes.push(...rendered)
  else nodes.push(rendered)
}

function highlightedTextNodes(text: string, highlightTerms: readonly string[], keyPrefix: string, renderText: InlineTextRenderer = (value) => value): ReactNode {
  if (!text) return text
  if (highlightTerms.length === 0) return renderText(text, keyPrefix, 0)

  const normalizedChars: string[] = []
  const originalIndexes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\u200B') continue
    normalizedChars.push(char)
    originalIndexes.push(index)
  }

  const normalizedText = normalizedChars.join('').toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of highlightTerms) {
    if (!term) continue
    let searchFrom = 0
    while (searchFrom < normalizedText.length) {
      const start = normalizedText.indexOf(term, searchFrom)
      if (start === -1) break
      const end = start + term.length
      ranges.push({ start, end })
      searchFrom = end
    }
  }

  if (ranges.length === 0) return renderText(text, keyPrefix, 0)

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const mergedRanges: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      mergedRanges.push({ ...range })
    }
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  for (const range of mergedRanges) {
    const originalStart = originalIndexes[range.start]
    const originalEnd = range.end < originalIndexes.length ? originalIndexes[range.end] : text.length
    if (originalStart > cursor) appendTextNodes(nodes, text.slice(cursor, originalStart), `${keyPrefix}:${cursor}:${originalStart}`, cursor, renderText)
    nodes.push(
      <mark
        key={`${keyPrefix}-${originalStart}-${originalEnd}`}
        className="chip-filter-match rounded-[2px] bg-[rgba(234,179,8,0.42)] text-tab-ink [font:inherit] [corner-shape:squircle] [-webkit-box-decoration-break:clone] [box-decoration-break:clone]"
      >
        {text.slice(originalStart, originalEnd)}
      </mark>
    )
    cursor = originalEnd
  }

  if (cursor < text.length) appendTextNodes(nodes, text.slice(cursor), `${keyPrefix}:${cursor}:tail`, cursor, renderText)
  return nodes
}

function isChipTextTruncated(textEl: HTMLElement | null) {
  if (!textEl) return false
  return (
    textEl.scrollHeight - textEl.clientHeight > 1 ||
    textEl.scrollWidth - textEl.clientWidth > 1
  )
}

function getChipTextWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().width * 100) / 100
}

function getChipTextHeight(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().height * 100) / 100
}

function roundToDevicePixel(value: number, win: Window | null = typeof window === 'undefined' ? null : window) {
  const scale = win?.devicePixelRatio || 1
  return Math.round(value * scale) / scale
}

function getChipTooltipSubpixelOffset(anchorEl: HTMLElement | null): TooltipSubpixelOffset {
  if (!anchorEl) return { x: 0, y: 0 }

  const rect = anchorEl.getBoundingClientRect()
  const win = anchorEl.ownerDocument.defaultView || window
  const left = rect.left - PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX
  const top = rect.top - PAGE_CHIP_TOOLTIP_TEXT_TOP_INSET_PX

  return {
    x: left - roundToDevicePixel(left, win),
    y: top - roundToDevicePixel(top, win)
  }
}

function chipTooltipSubpixelOffsetsEqual(left: TooltipSubpixelOffset, right: TooltipSubpixelOffset) {
  return (
    Math.abs(left.x - right.x) < PAGE_CHIP_TOOLTIP_SUBPIXEL_TOLERANCE_PX &&
    Math.abs(left.y - right.y) < PAGE_CHIP_TOOLTIP_SUBPIXEL_TOLERANCE_PX
  )
}

function getChipTooltipMaxWidth(textEl: HTMLElement | null) {
  if (!textEl || typeof window === 'undefined') return 0

  const textRect = textEl.getBoundingClientRect()
  const maxWidth = window.innerWidth - textRect.left - PAGE_CHIP_TOOLTIP_VIEWPORT_MARGIN_PX + PAGE_CHIP_TOOLTIP_MAX_WIDTH_OFFSET_PX
  return Math.max(0, Math.round(maxWidth * 100) / 100)
}

function getChipTextLineHeight(textEl: HTMLElement | null) {
  if (!textEl || typeof window === 'undefined') return PAGE_CHIP_TOOLTIP_LINE_HEIGHT_FALLBACK_PX
  const lineHeight = Number.parseFloat(window.getComputedStyle(textEl).lineHeight)
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : PAGE_CHIP_TOOLTIP_LINE_HEIGHT_FALLBACK_PX
}

function getVisibleChipTextLineCount(textEl: HTMLElement | null) {
  if (!textEl) return 1
  const lineHeight = getChipTextLineHeight(textEl)
  const height = getChipTextHeight(textEl)
  if (height <= 0 || lineHeight <= 0) return 1
  return Math.max(1, Math.round(height / lineHeight))
}

function tooltipLineContentOverflows(line: HTMLElement) {
  if (line.scrollWidth - line.clientWidth > PAGE_CHIP_TOOLTIP_LINE_TOLERANCE_PX) return true

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
          rect.right - lineRect.right > PAGE_CHIP_TOOLTIP_LINE_TOLERANCE_PX
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

function tooltipMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const lineHeight = getChipTextLineHeight(measureEl)
  const height = measureEl.getBoundingClientRect().height
  const fixedLineOverflows = Array.from(measureEl.querySelectorAll<HTMLElement>('.page-chip-tooltip-line:not(.page-chip-tooltip-line-tail)'))
    .some(tooltipLineContentOverflows)
  const markerWrapsTaller = Array.from(measureEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator'))
    .some((marker) => marker.getBoundingClientRect().height > lineHeight + PAGE_CHIP_TOOLTIP_LINE_TOLERANCE_PX)
  return !fixedLineOverflows && !markerWrapsTaller && height <= targetLineCount * lineHeight + PAGE_CHIP_TOOLTIP_LINE_TOLERANCE_PX
}

type ChipTooltipDomPosition = {
  node: Text
  offset: number
}
type RegularChipTooltipMetrics = {
  viewportConstrained: boolean
  width: number
}

function paintedRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  return rects[rects.length - 1] || null
}

function fragmentHtml(document: Document, fragment: DocumentFragment) {
  const container = document.createElement('span')
  hydrateClonedChipTooltipFragment(document, fragment)
  container.append(fragment)
  return container.innerHTML
}

function carriedTooltipMarkerToneClass(marker: Element) {
  return Array.from(marker.classList)
    .filter((className) => (
      className.startsWith('title-suppression-token-tone-') ||
      /^(border|bg|ring)-(yellow|teal|sky|rose)-/.test(className) ||
      className === 'ring-1' ||
      className === 'ring-inset' ||
      className === 'text-tab-ink'
    ))
    .join(' ')
}

function ensureLeadingTooltipMarkerSpace(document: Document, marker: Element) {
  const previous = marker.previousSibling
  if (previous?.textContent && /\s$/.test(previous.textContent)) return
  marker.before(document.createTextNode(' '))
}

function hydrateClonedChipTooltipFragment(document: Document, fragment: DocumentFragment) {
  for (const marker of Array.from(fragment.querySelectorAll('.chip-title-suppression-marker'))) {
    const label = marker.getAttribute('aria-label') || ''
    const hiddenTitleText = label.replace(/^Suppressed title text:\s*/, '').trim()
    if (!hiddenTitleText) continue

    ensureLeadingTooltipMarkerSpace(document, marker)
    marker.className = cn(PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, carriedTooltipMarkerToneClass(marker))
    marker.replaceChildren(document.createTextNode(hiddenTitleText))
  }

  for (const marker of Array.from(fragment.querySelectorAll('.chip-strip-indicator'))) {
    const label = marker.getAttribute('aria-label') || ''
    if (!label) continue

    marker.className = PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME
    marker.replaceChildren(document.createTextNode(label))
  }
}

function getRegularChipTooltipLineHtml(textEl: HTMLElement | null) {
  if (!textEl || typeof document === 'undefined') return []

  const visibleLineCount = getVisibleChipTextLineCount(textEl)
  if (visibleLineCount <= 1) return []

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const textRect = textEl.getBoundingClientRect()
  const lineHeight = getChipTextLineHeight(textEl)
  if (textRect.height <= 0 || lineHeight <= 0) return []

  const walker = ownerDocument.createTreeWalker(
    textEl,
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
  const lineStarts: ChipTooltipDomPosition[] = []
  let lastLineIndex = -1

  while (lineStarts.length < visibleLineCount) {
    const node = walker.nextNode()
    if (!(node instanceof win.Text)) break

    const text = node.data
    for (let offset = 0; offset < text.length && lineStarts.length < visibleLineCount; offset += 1) {
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      const rect = paintedRangeRect(range)
      if (!rect) continue

      const lineIndex = Math.max(0, Math.round((rect.top - textRect.top) / lineHeight))
      if (lineIndex >= visibleLineCount) break
      if (lineIndex > lastLineIndex) {
        lineStarts.push({ node, offset })
        lastLineIndex = lineIndex
      }
    }
  }

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
      lineRange.selectNodeContents(textEl)
      lineRange.setStart(start.node, start.offset)
    }
    lines.push(fragmentHtml(ownerDocument, lineRange.cloneContents()))
  }

  return lines
}

function chipTooltipLineHtmlEquals(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

function chipTooltipLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  const lastIndex = lineHtml.length - 1
  return `<span class="${PAGE_CHIP_TOOLTIP_LINES_CLASS_NAME}">${lineHtml.map((html, index) => (
    `<span class="${index === lastIndex ? PAGE_CHIP_TOOLTIP_TAIL_LINE_CLASS_NAME : viewportConstrained ? PAGE_CHIP_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME : PAGE_CHIP_TOOLTIP_LINE_CLASS_NAME}">${html}</span>`
  )).join('')}</span>`
}

function tooltipLineNodesFromHtml(html: string, keyPrefix: string): ReactNode {
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

function createSplitChipTooltipMeasureElement(
  textEl: HTMLElement,
  templateEl: HTMLElement | null,
  lineHtml: readonly string[]
) {
  const ownerDocument = textEl.ownerDocument
  if (!ownerDocument.body) return null

  const measureEl = ownerDocument.createElement('span')
  measureEl.className = templateEl?.className || 'page-chip-tooltip-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [hyphenate-character:\'\'] [overflow-wrap:break-word]'
  measureEl.setAttribute('aria-hidden', 'true')
  measureEl.innerHTML = chipTooltipLineMarkup(lineHtml)
  ownerDocument.body.appendChild(measureEl)
  return measureEl
}

function getRegularChipTooltipWidth(
  textEl: HTMLElement | null,
  measureEl: HTMLElement | null,
  lineHtml: readonly string[] = []
): RegularChipTooltipMetrics {
  if (!textEl || !measureEl) return { viewportConstrained: false, width: 0 }

  const visibleWidth = getChipTextWidth(textEl)
  const maxPopupWidth = getChipTooltipMaxWidth(textEl)
  const maxContentWidth = Math.max(0, maxPopupWidth - PAGE_CHIP_TOOLTIP_HORIZONTAL_PADDING_PX)
  const targetLineCount = getVisibleChipTextLineCount(textEl)
  if (visibleWidth <= 0 || maxContentWidth <= 0) return { viewportConstrained: false, width: visibleWidth }

  const splitMeasureEl = lineHtml.length > 0
    ? createSplitChipTooltipMeasureElement(textEl, measureEl, lineHtml)
    : null
  const activeMeasureEl = splitMeasureEl || measureEl

  try {
    const lowerBound = Math.min(visibleWidth, maxContentWidth)
    if (tooltipMeasureFitsLineCount(activeMeasureEl, lowerBound, targetLineCount)) {
      return { viewportConstrained: false, width: Math.round(lowerBound * 100) / 100 }
    }

    if (!tooltipMeasureFitsLineCount(activeMeasureEl, maxContentWidth, targetLineCount)) {
      return { viewportConstrained: true, width: Math.round(maxContentWidth * 100) / 100 }
    }

    let low = lowerBound
    let high = maxContentWidth
    for (let index = 0; index < PAGE_CHIP_TOOLTIP_WIDTH_SEARCH_STEPS; index += 1) {
      const mid = (low + high) / 2
      if (tooltipMeasureFitsLineCount(activeMeasureEl, mid, targetLineCount)) high = mid
      else low = mid
    }

    return { viewportConstrained: false, width: Math.round(high * 100) / 100 }
  } finally {
    splitMeasureEl?.remove()
  }
}

function syncChipTextFade(textEl: HTMLElement | null) {
  if (!textEl) return { height: 0, isTruncated: false, width: 0, maxWidth: 0 }

  const isTruncated = isChipTextTruncated(textEl)
  const width = getChipTextWidth(textEl)
  const height = getChipTextHeight(textEl)
  const maxWidth = getChipTooltipMaxWidth(textEl)
  textEl.classList.toggle('chip-text-truncated', isTruncated)
  chipTextTruncationCallbacks.get(textEl)?.({ height, isTruncated, maxWidth, width })
  return { height, isTruncated, width, maxWidth }
}

function getChipTextMetrics(textEl: HTMLElement | null): ChipTextMetrics {
  const { isTruncated, width, maxWidth } = syncChipTextFade(textEl)
  return { isTruncated, maxWidth, width }
}

function chipTextMetricsEqual(left: ChipTextMetrics, right: ChipTextMetrics) {
  return (
    left.isTruncated === right.isTruncated &&
    Math.abs(left.width - right.width) < 0.1 &&
    Math.abs(left.maxWidth - right.maxWidth) < 0.1
  )
}

function chipLayoutReducer(state: ChipLayoutState, action: ChipLayoutAction): ChipLayoutState {
  if (action.type === 'textMetrics') {
    return chipTextMetricsEqual(state.textMetrics, action.metrics)
      ? state
      : { ...state, textMetrics: action.metrics }
  }

  const tooltipLayoutUnchanged =
    chipTooltipLineHtmlEquals(state.tooltipLineHtml, action.lineHtml) &&
    state.tooltipViewportConstrained === action.viewportConstrained &&
    Math.abs(state.tooltipWidth - action.width) < 0.1 &&
    chipTooltipSubpixelOffsetsEqual(state.tooltipSubpixelOffset, action.subpixelOffset)

  return tooltipLayoutUnchanged
    ? state
    : {
        ...state,
        tooltipLineHtml: action.lineHtml,
        tooltipSubpixelOffset: action.subpixelOffset,
        tooltipViewportConstrained: action.viewportConstrained,
        tooltipWidth: action.width
      }
}

function getChipTextResizeObserver() {
  if (typeof ResizeObserver !== 'function') return null
  if (!chipTextResizeObserver) {
    chipTextResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) syncChipTextFade(entry.target)
      }
    })
  }
  return chipTextResizeObserver
}

function usePageChipElement({ chip, filter = '', suppressedTitleToneByText }: PageChipProps) {
  const { activeSuppressedTitle, dedupeBadgesClosing, onHoverUrlChange, activeHoverUrl, activeHoverUrls, activeHoverSource, onLayoutChange } = useDomainCardContext()
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const titleVariantChips = Array.isArray(chip.titleVariantChips) ? chip.titleVariantChips : []
  const isTitleVariantGroup = titleVariantChips.length > 1
  const parentInteractive = !isFolded && !isTitleVariantGroup
  const hasFilter = filter.trim().length > 0
  const isHistorySource = chip.sourceType === 'history'
  const isClosedSavedPage = chip.sourceType === 'saved-page' || !!chip.closedSaved
  const highlightTerms = highlightTermsForFilter(filter, isHistorySource ? 'legacy' : 'parsed')
  const isReadOnlySource = isReadOnlyDashboardSourceType(chip.sourceType)
  const primaryPreviewUrl = pageTargetUrl(chip)
  const suppressedTitleParts = chip.suppressedTitleParts || []
  const activeSuppressedTitleKey = activeSuppressedTitle.trim().toLowerCase()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const suppressionHighlighted = activeSuppressedTitleKey !== '' && suppressedTitleParts.some((part) => part.toLowerCase() === activeSuppressedTitleKey)
  const isSplitTitleTooltip = !chip.iconOnly
  const isRegularTitleTooltip = !chip.iconOnly && !isFolded && !isTitleVariantGroup
  const chipTextRef = useRef<HTMLSpanElement | null>(null)
  const chipTooltipMeasureRef = useRef<HTMLSpanElement | null>(null)
  const updateChipTextMeasurementsRef = useRef<(textEl: HTMLElement | null) => void>(() => {})
  const contextMenuOpenRef = useRef(false)
  const [chipTooltipOpen, setChipTooltipOpen] = useState(false)
  const [chipLayout, dispatchChipLayout] = useReducer(chipLayoutReducer, DEFAULT_CHIP_LAYOUT_STATE)
  const {
    textMetrics: chipTextMetrics,
    tooltipLineHtml: chipTooltipLineHtml,
    tooltipSubpixelOffset: chipTooltipSubpixelOffset,
    tooltipViewportConstrained: chipTooltipViewportConstrained,
    tooltipWidth: chipTooltipWidth
  } = chipLayout
  const { isTruncated: isTextTruncated, maxWidth: chipTooltipMaxWidth, width: chipTextWidth } = chipTextMetrics

  const syncChipTooltipLayout = useCallback((textEl: HTMLElement | null) => {
    const titleTextEl = isFolded || isTitleVariantGroup
      ? textEl?.querySelector<HTMLElement>('.chip-title-row') || null
      : textEl
    const lineHtml = isSplitTitleTooltip ? getRegularChipTooltipLineHtml(titleTextEl) : []
    const tooltipMetrics = isRegularTitleTooltip
      ? getRegularChipTooltipWidth(textEl, chipTooltipMeasureRef.current, lineHtml)
      : { viewportConstrained: false, width: 0 }
    const subpixelOffset = getChipTooltipSubpixelOffset(titleTextEl)
    dispatchChipLayout({
      type: 'tooltipLayout',
      lineHtml,
      subpixelOffset,
      viewportConstrained: tooltipMetrics.viewportConstrained,
      width: tooltipMetrics.width
    })
  }, [isFolded, isRegularTitleTooltip, isSplitTitleTooltip, isTitleVariantGroup])

  const updateChipTextMeasurements = useCallback((textEl: HTMLElement | null) => {
    const nextMetrics = getChipTextMetrics(textEl)
    dispatchChipLayout({ type: 'textMetrics', metrics: nextMetrics })
    syncChipTooltipLayout(textEl)
  }, [syncChipTooltipLayout])

  useEffect(() => {
    updateChipTextMeasurementsRef.current = updateChipTextMeasurements
  }, [updateChipTextMeasurements])

  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    updateChipTextMeasurements(textEl)
    const frameId = requestAnimationFrame(() => updateChipTextMeasurements(textEl))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    let disposed = false
    const observer = getChipTextResizeObserver()
    chipTextTruncationCallbacks.set(textEl, ({ isTruncated, maxWidth, width }) => {
      if (disposed) return
      dispatchChipLayout({ type: 'textMetrics', metrics: { isTruncated, maxWidth, width } })
      syncChipTooltipLayout(textEl)
    })
    observer?.observe(textEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (!disposed) updateChipTextMeasurementsRef.current(textEl)
    }
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(onFontsDone)

    return () => {
      disposed = true
      observer?.unobserve(textEl)
      chipTextTruncationCallbacks.delete(textEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
    }
  }, [syncChipTooltipLayout])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function focusChipUrl(targetUrl: string | undefined, sourceType = chip.sourceType) {
    if (!targetUrl) return
    if (isReadOnlyDashboardSourceType(sourceType)) {
      const focused = await focusExactTab(targetUrl)
      if (!focused) await openTabUrl(targetUrl)
      return
    }
    await focusTab(targetUrl)
  }

  async function onFocus() {
    if (isFolded) return
    await focusChipUrl(chip.tabUrl)
  }

  async function onPageChipTooltipClick(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!parentInteractive) return
    await onFocus()
  }

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus()
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    await focusChipUrl(env.tabUrl, env.sourceType || chip.sourceType)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    await focusChipUrl(env.tabUrl, env.sourceType || chip.sourceType)
  }

  function setPreview(url: string, matchUrls: readonly string[] = [url]) {
    if (onHoverUrlChange) onHoverUrlChange(url || '', 'chip', matchUrls)
  }

  function previewUrlsForChip(target: DashboardChipData): string[] {
    return pageTargetMatchUrls(target)
  }

  function onChipContextMenuOpenChange(open: boolean) {
    contextMenuOpenRef.current = open
    if (open) {
      setPreview(primaryPreviewUrl, previewUrlsForChip(chip))
      return
    }
    setPreview('')
  }

  function onEnvContextMenuOpenChange(open: boolean, env: DashboardChipEnv) {
    contextMenuOpenRef.current = open
    if (open) {
      setPreview(env.tabUrl, [env.tabUrl, env.rawUrl])
      return
    }
    setPreview('')
  }

  function onChipMouseEnter() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip))
  }

  function onChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onChipTextPointerEnter(e: PointerEvent<HTMLSpanElement>) {
    updateChipTextMeasurements(e.currentTarget)
  }

  function onChipTextTooltipHitAreaPointerEnter() {
    const textEl = chipTextRef.current
    if (textEl) updateChipTextMeasurements(textEl)
  }

  function onChipFocus() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip))
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onEnvMouseEnter(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl])
  }

  function onEnvMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onEnvFocus(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl])
  }

  function onEnvBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  async function onClose(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')

    await closeChipTarget({
      tabUrl: chip.tabUrl,
      envs,
      onAfterClose: async ({ shouldAnimateRemoval }) => {
        if (shouldAnimateRemoval && chipEl) {
          if (startPageChipCloseAnimation(chipEl, onLayoutChange)) await waitForPageChipCloseAnimation()
        }
        setPreview('')
      }
    })
  }

  async function onDeleteHistory(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const urls = Array.from(new Set(isFolded ? envs.flatMap((env) => env.tabUrl ? [env.tabUrl] : []) : chip.tabUrl ? [chip.tabUrl] : []))
    if (urls.length === 0) return

    await deleteHistoryUrls({
      urls,
      onAfterDelete: async () => {
        if (startPageChipCloseAnimation(chipEl, onLayoutChange)) await waitForPageChipCloseAnimation()
        setPreview('')
      }
    })
  }

  async function onToggleSavedPage(e: StopPropagationEvent) {
    e.stopPropagation()
    if (chip.saved) {
      await removeSavedPageTarget(chip.savedPageKey || chip.tabUrl)
    } else {
      await savePageTarget({
        url: chip.tabUrl,
        rawUrl: chip.rawUrl,
        title: chip.title || chip.tooltip,
        favIconUrl: chip.faviconUrl,
        isTabOut: false,
        isApp: chip.isApp
      })
    }
    setPreview('')
  }

  async function onCopyTitleText(e: StopPropagationEvent, titleText: string) {
    e.stopPropagation()
    if (!titleText) return

    try {
      await navigator.clipboard.writeText(titleText)
      showToast('Page title copied')
    } catch {
      showToast('Could not copy page title')
    }
  }

  async function onTitleVariantFocus(e: MouseEvent<HTMLButtonElement>, variant: DashboardChipData) {
    e.stopPropagation()
    await focusChipUrl(variant.tabUrl, variant.sourceType)
  }

  function onTitleVariantMouseEnter(variant: DashboardChipData) {
    setPreview(variant.tabUrl, previewUrlsForChip(variant))
  }

  function onTitleVariantMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onTitleVariantFocusIn(variant: DashboardChipData) {
    setPreview(variant.tabUrl, previewUrlsForChip(variant))
  }

  function onTitleVariantBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) return
    setPreview('')
  }

  async function onCloseTitleVariant(e: MouseEvent<HTMLButtonElement>, variant: DashboardChipData) {
    e.stopPropagation()
    if (variant.sourceType === 'history') {
      await deleteHistoryUrls({
        urls: [variant.tabUrl].filter(Boolean),
        onAfterDelete: async () => setPreview('')
      })
      return
    }

    await closeChipTarget({
      tabUrl: variant.tabUrl,
      onAfterClose: async () => setPreview('')
    })
  }

  async function onToggleSavedTitleVariant(e: StopPropagationEvent, variant: DashboardChipData) {
    e.stopPropagation()
    if (variant.saved) {
      await removeSavedPageTarget(variant.savedPageKey || variant.tabUrl)
    } else {
      await savePageTarget({
        url: variant.tabUrl,
        rawUrl: variant.rawUrl,
        title: variant.title || variant.tooltip,
        favIconUrl: variant.faviconUrl,
        isTabOut: false,
        isApp: variant.isApp
      })
    }
    setPreview('')
  }

  async function onToggleSavedEnv(e: StopPropagationEvent, env: DashboardChipEnv) {
    e.stopPropagation()
    if (env.saved) {
      await removeSavedPageTarget(env.savedPageKey || env.tabUrl)
    } else {
      await savePageTarget({
        url: env.tabUrl,
        rawUrl: env.rawUrl,
        title: env.title || chip.title || chip.tooltip,
        favIconUrl: env.faviconUrl || chip.faviconUrl,
        isTabOut: false,
        isApp: !!env.isApp
      })
    }
    setPreview('')
  }

  const hasActiveChipFrame = !!(chip.activeChipFrame || chip.activeInOtherWindow)
  const isCurrentActiveFrame = !!chip.activeChipFrame && !chip.activeInOtherWindow
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const savedLabel = chip.saved ? (isClosedSavedPage ? 'Closed saved page' : 'Saved page') : ''
  const hiddenTitleLabel = suppressedTitleParts.length > 0 ? `Suppressed title text: ${suppressedTitleParts.join(' · ')}` : ''
  const titleVariantLabel = isTitleVariantGroup ? `${titleVariantChips.length} URL variants: ${titleVariantChips.map((variant) => variant.pathSuffix || variant.tabUrl).join(' · ')}` : ''
  const chipLabel = [chip.tooltip, titleVariantLabel, hiddenTitleLabel, duplicateLabel, activeLabel, savedLabel].filter(Boolean).join(' · ')
  const closeActionLabel = isHistorySource ? 'Delete from history' : 'Close this tab'
  const savedActionLabel = chip.saved ? 'Remove saved page' : 'Save page'
  const chipTitleText = titleTextForChip(chip)
  const canToggleSavedPage = parentInteractive && (chip.sourceType === 'tab' || chip.sourceType === 'saved-page') && !chip.isApp
  const showSavedHint = parentInteractive && !!chip.saved && !canToggleSavedPage
  const canCloseChip = parentInteractive && !isClosedSavedPage && (!isReadOnlySource || isHistorySource)
  const showFaviconCloseAction = !chip.iconOnly && canCloseChip
  const showDefaultFavicon = !chip.faviconUrl && (!isReadOnlySource || chip.sourceType === 'saved-page')
  const showFaviconFrame = !!chip.faviconUrl || showDefaultFavicon || dupeCount > 1 || showFaviconCloseAction
  const rightActionCount = showSavedHint ? 1 : 0
  const chipHoverFadeWidth = rightActionCount === 0 ? '0px' : rightActionCount === 1 ? '56px' : '88px'
  const style = {
    '--chip-hover-fade-bg': hasActiveChipFrame
      ? 'color-mix(in srgb, var(--card-bg) 82%, rgb(82 82 82))'
      : 'color-mix(in srgb, var(--card-bg) 87%, rgb(82 82 82))',
    '--chip-hover-fade-width': chipHoverFadeWidth,
    ...(chip.isGrouped ? { '--group-color': chip.groupDotColor } : {})
  } as CSSProperties
  const hasTitleSuppressionMarkers = suppressedTitleParts.length > 0 || chip.displaySegments.some(isTitleSuppressionSegment)
  const hasStructuralPlaceholders = chip.displaySegments.some((segment) => isStructuralPlaceholderSegment(segment) && !!(segment.label || chip.pathGroupLabel))
  const shouldShowChipTooltip = chip.iconOnly || isTextTruncated || hasTitleSuppressionMarkers || hasStructuralPlaceholders
  const chipTooltipTextWidth = !chip.iconOnly && chipTextWidth > 0 ? `${chipTextWidth}px` : ''
  const regularChipTooltipWidth = isRegularTitleTooltip && chipTooltipWidth > 0 ? `${chipTooltipWidth}px` : ''
  const chipTooltipMaxWidthValue = chipTooltipMaxWidth > 0 ? `${chipTooltipMaxWidth}px` : 'calc(100vw - 16px)'
  const chipTooltipStyle = {
    ...(chipTooltipTextWidth ? { '--page-chip-tooltip-text-width': chipTooltipTextWidth } : {}),
    ...(regularChipTooltipWidth ? { '--page-chip-tooltip-width': regularChipTooltipWidth } : {}),
    '--page-chip-tooltip-max-width': chipTooltipMaxWidthValue,
    maxWidth: 'min(var(--page-chip-tooltip-max-width), calc(100vw - 16px))',
    paddingLeft: `${PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX}px`,
    paddingRight: `${PAGE_CHIP_TOOLTIP_TEXT_RIGHT_INSET_PX}px`
  } as CSSProperties
  const chipTooltipSubpixelTransform = chipTooltipSubpixelOffsetsEqual(chipTooltipSubpixelOffset, { x: 0, y: 0 })
    ? ''
    : `translate3d(${chipTooltipSubpixelOffset.x}px, ${chipTooltipSubpixelOffset.y}px, 0)`
  const chipTooltipTextStyle = chipTooltipSubpixelTransform
    ? { transform: chipTooltipSubpixelTransform } as CSSProperties
    : undefined
  function chipMatchesActiveHover(target: DashboardChipData) {
    return (
      pageTargetMatchesHover(target, activeHoverUrl, activeHoverUrls) ||
      !!target.envs?.some((env) => (
        pageTargetMatchesHover(env, activeHoverUrl, activeHoverUrls)
      ))
    )
  }

  function getChipTooltipAnchorElement() {
    const textEl = chipTextRef.current
    if (!textEl) return null
    if (!isFolded && !isTitleVariantGroup) return textEl
    return textEl.querySelector<HTMLElement>('.chip-title-row') || textEl
  }

  function getChipTooltipAnchor() {
    const anchorEl = getChipTooltipAnchorElement()
    if (!anchorEl) return null

    const rect = anchorEl.getBoundingClientRect()
    const contentWidth = isRegularTitleTooltip && chipTooltipWidth > 0
      ? chipTooltipWidth
      : getChipTextWidth(anchorEl)
    const maxPopupWidth = Math.max(
      0,
      getChipTooltipMaxWidth(anchorEl) + PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX
    )
    const popupWidth = Math.min(
      Math.max(1, contentWidth + PAGE_CHIP_TOOLTIP_HORIZONTAL_PADDING_PX),
      maxPopupWidth || contentWidth + PAGE_CHIP_TOOLTIP_HORIZONTAL_PADDING_PX
    )
    const left = rect.left - PAGE_CHIP_TOOLTIP_TEXT_LEFT_INSET_PX
    const top = rect.top - PAGE_CHIP_TOOLTIP_TEXT_TOP_INSET_PX

    return {
      getBoundingClientRect: () => new DOMRect(left, top, popupWidth, 0)
    }
  }

  const externalHoverActive = !!activeHoverSource && activeHoverSource !== 'chip' && !!activeHoverUrl
  const hoverMatched = externalHoverActive && (
    chipMatchesActiveHover(chip) ||
    titleVariantChips.some((variant) => chipMatchesActiveHover(variant))
  )

  function suppressionMarkerNode(part: string, mode: ChipTextRenderMode, key: string, markerClassName = '') {
    const partKey = part.trim().toLowerCase()
    const active = activeSuppressedTitleKey !== '' && partKey === activeSuppressedTitleKey
    const tone = active ? activeSuppressionTone : suppressedTitleToneByText?.get(partKey) ?? ''
    const label = `Suppressed title text: ${part}`
    const marker = (
      <span
        key={key}
        className={cn(
          'chip-title-suppression-marker inline-flex h-[14px] min-w-[14px] shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-[rgba(115,115,115,0.08)] px-[3px] text-[12px] leading-[12px] text-tab-muted align-middle [corner-shape:squircle]',
          markerClassName,
          titleSuppressionMarkerClass(tone, active)
        )}
        aria-label={label}
      >
        <svg className="chip-title-suppression-glyph h-[7px] w-2" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.25 5.4c1.25-1.45 2.5-1.45 3.75 0s2.5 1.45 3.75 0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
      </span>
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={key}
          className={cn(
            PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME,
            markerClassName,
            titleSuppressionMarkerClass(tone, active)
          )}
          aria-label={label}
        >
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function trailingSuppressionMarkerNodes(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode) {
    const targetSuppressedTitleParts = target.suppressedTitleParts || []
    if (targetSuppressedTitleParts.length === 0) return null

    const inlineSuppressedTitleKeys = new Set(
      target.displaySegments.flatMap((segment) => (
        isTitleSuppressionSegment(segment)
          ? [segment.titleSuppression.trim().toLowerCase()]
          : []
      ))
    )
    const trailingParts = targetSuppressedTitleParts.filter((part) => !inlineSuppressedTitleKeys.has(part.trim().toLowerCase()))

    return trailingParts.map((part, index) => {
      const markerSpacingClass = mode === 'chip' ? (index === 0 ? 'ml-1' : 'ml-0.5') : ''
      const marker = suppressionMarkerNode(
        part,
        mode,
        `${keyPrefix}-trailing-title-suppression-marker-${part}`,
        markerSpacingClass
      )

      if (mode === 'tooltip') {
        return (
          <span key={`${keyPrefix}-trailing-title-suppression-${part}-${index}`}>
            {' '}
            {marker}
          </span>
        )
      }

      return marker
    })
  }

  function structuralPlaceholderNode(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabel = chip.pathGroupLabel) {
    const hiddenLabel = segment.label || fallbackLabel
    const marker = (
      <span
        key={key}
        className="chip-strip-indicator inline-flex size-4 items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] text-xs leading-none font-medium text-tab-muted align-baseline"
        aria-hidden={hiddenLabel ? undefined : true}
        aria-label={hiddenLabel || undefined}
      >
        /
      </span>
    )

    if (mode === 'tooltip' && hiddenLabel) {
      return (
        <span
          key={key}
          className={PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME}
          aria-label={hiddenLabel}
        >
          {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function envLabelNode(env: DashboardChipEnv, mode: ChipTextRenderMode) {
    const envLabel = `Focus ${env.prefix} tab${env.activeInOtherWindow ? ' (active in another window)' : ''}`
    const envSavedActionLabel = env.saved ? 'Remove saved page' : 'Save page'
    const canToggleSavedEnv = (env.sourceType === 'tab' || env.sourceType === 'saved-page') && !env.isApp
    const showSavedEnvHint = !!env.saved && !canToggleSavedEnv
    const envTitleText = titleTextForEnv(env, chip)
    const envKey = env.rawUrl || env.tabUrl
    const envClassName = cn(
      "chip-env inline-flex items-center rounded-lg border-0 bg-[rgba(115,115,115,0.05)] px-1.5 text-xs leading-[inherit] font-medium text-tab-muted [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.']",
      isFolded && 'h-6 rounded-[7px] px-2',
      mode === 'chip' && 'clickable cursor-default transition-[background,color,box-shadow] duration-150 ease-in-out hover:bg-[rgba(10,10,10,0.12)] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)] [&.page-chip-context-menu-open]:bg-[rgba(10,10,10,0.12)] [&.page-chip-context-menu-open]:text-tab-ink',
      env.activeInOtherWindow && 'bg-[rgba(82,82,82,0.13)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]'
    )

    if (mode === 'tooltip') {
      return (
        <span key={envKey} className={envClassName}>
          {highlightedTextNodes(env.prefix, highlightTerms, `tooltip-env-${env.prefix}`)}
        </span>
      )
    }

    const envFocusButton = (
      <button
        type="button"
        className={envClassName}
        aria-label={envLabel}
        onClick={(e) => onEnvClick(e, env)}
        onKeyDown={(e) => onEnvKeyDown(e, env)}
        onMouseEnter={() => onEnvMouseEnter(env)}
        onMouseLeave={onEnvMouseLeave}
        onFocus={() => onEnvFocus(env)}
        onBlur={onEnvBlur}
      >
        {highlightedTextNodes(env.prefix, highlightTerms, `env-${env.prefix}`)}
      </button>
    )
    const envFocusTarget = canToggleSavedEnv ? (
      <PageChipContextMenu
        savedActionLabel={envSavedActionLabel}
        saved={!!env.saved}
        onSavedSelect={(e) => onToggleSavedEnv(e, env)}
        titleText={envTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, envTitleText)}
        onOpenChange={(open) => onEnvContextMenuOpenChange(open, env)}
      >
        {envFocusButton}
      </PageChipContextMenu>
    ) : envFocusButton

    if (!showSavedEnvHint) return <span key={envKey} className="chip-env-shell relative inline-flex items-center">{envFocusTarget}</span>

    return (
      <span key={envKey} className="chip-env-shell group/env relative inline-flex items-center">
        {envFocusTarget}
        <TooltipAnchor content="Saved page">
          <span
            className="chip-env-saved-hint pointer-events-none absolute -top-1.5 -right-1.5 z-[2] inline-flex size-4 cursor-default items-center justify-center rounded-full border border-tab-card bg-[var(--card-bg)] p-0 text-[var(--accent-amber)] opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.14)] group-hover/env:pointer-events-auto group-hover/env:opacity-100"
            aria-hidden="true"
          >
            <SavedPageIcon saved className="size-2.5" />
          </span>
        </TooltipAnchor>
      </span>
    )
  }

  function titleContentNode(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode, options: RenderTitleContentOptions = {}) {
    const includePathSuffix = options.includePathSuffix ?? true

    return (
      <>
        {target.pathGroupLabel && (
          <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]">
            {highlightedTextNodes(pathGroupDisplayLabel(target.pathGroupLabel), highlightTerms, `${keyPrefix}-pathgroup`)}
          </span>
        )}
        {target.displaySegments.map((seg, index) => {
          if (typeof seg === 'string') {
            return isUrlLikeTitle(seg)
              ? highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`)
              : highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`, createBionicTitleTextRenderer(seg))
          }
          if (isTitleSuppressionSegment(seg)) return suppressionMarkerNode(seg.titleSuppression, mode, `${keyPrefix}-inline-title-suppression-${index}`)
          if (isStructuralPlaceholderSegment(seg)) return structuralPlaceholderNode(seg, mode, `${keyPrefix}-structural-placeholder-${index}`, target.pathGroupLabel)
          return null
        })}
        {trailingSuppressionMarkerNodes(mode, target, keyPrefix)}
        {includePathSuffix && target.pathSuffix && (
          <>
            {' '}
            <span
              className={cn(
                'chip-path text-xs font-normal text-tab-muted opacity-75',
                mode === 'chip'
                  ? 'inline-block whitespace-nowrap'
                  : 'inline-block max-w-[calc(100%-6px)] whitespace-normal break-normal [width:max-content] [overflow-wrap:break-word]'
              )}
            >
              {highlightedTextNodes(target.pathSuffix, highlightTerms, `${keyPrefix}-path`)}
            </span>
          </>
        )}
      </>
    )
  }

  function titleVariantActionLabel(variant: DashboardChipData) {
    return `${variant.sourceType === 'history' ? 'Delete from history' : 'Close this tab'}: ${variant.pathSuffix || variant.tabUrl}`
  }

  function titleVariantNode(variant: DashboardChipData, index: number, mode: ChipTextRenderMode) {
    const label = variant.pathSuffix || variant.tabUrl || '/'
    const variantActive = !!(variant.activeChipFrame || variant.activeInOtherWindow)
    const variantCurrent = !!variant.activeChipFrame && !variant.activeInOtherWindow
    const variantHoverMatched = externalHoverActive && chipMatchesActiveHover(variant)
    const variantDupeCount = variant.dupeCount || 1
    const variantIsHistorySource = variant.sourceType === 'history'
    const variantClosedSaved = variant.sourceType === 'saved-page' || !!variant.closedSaved
    const variantCanToggleSaved = (variant.sourceType === 'tab' || variant.sourceType === 'saved-page') && !variant.isApp
    const variantShowSavedHint = !!variant.saved && !variantCanToggleSaved
    const variantCanClose = !variantClosedSaved && (!isReadOnlyDashboardSourceType(variant.sourceType) || variantIsHistorySource)
    const variantActionCount = (variantShowSavedHint ? 1 : 0) + (variantCanClose ? 1 : 0)
    const variantSavedActionLabel = variant.saved ? 'Remove saved page' : 'Save page'
    const variantTitleText = titleTextForChip(variant)
    const variantLabel = [variant.tooltip, variantDupeCount > 1 ? `${variantDupeCount} open copies` : '', variant.activeInOtherWindow ? 'Active in another window' : '', variant.saved ? (variantClosedSaved ? 'Closed saved page' : 'Saved page') : ''].filter(Boolean).join(' · ')
    const labelContent = (
      <>
        <span className="chip-title-variant-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {highlightedTextNodes(label, highlightTerms, `${mode}-title-variant-${index}`)}
        </span>
        {variantDupeCount > 1 && (
          <span className="chip-title-variant-dupe inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[rgba(254,243,199,0.95)] px-1 text-[9px] leading-none font-bold tabular-nums text-[rgb(120,53,15)]">
            {variantDupeCount}
          </span>
        )}
      </>
    )
    const variantFocusButton = (
      <button
        type="button"
        className={cn(
          'chip-title-variant clickable flex w-full max-w-full min-w-0 cursor-default items-center gap-1 rounded-lg border-0 bg-[rgba(115,115,115,0.07)] px-1.5 py-0.5 text-xs leading-tight font-medium text-tab-muted [corner-shape:squircle] hover:bg-[rgba(82,82,82,0.14)] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]',
          '[&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.14)] [&.page-chip-context-menu-open]:text-tab-ink',
          !variantActive && !variantCurrent && 'group-hover/page-chip:bg-[rgba(115,115,115,0.1)]',
          variantActive && 'bg-[rgba(82,82,82,0.11)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(115,115,115,0.2)]',
          variantCurrent && 'bg-neutral-100 shadow-[inset_0_0_0_1px_rgba(82,82,82,0.42)]',
          variantHoverMatched && 'shadow-[inset_0_0_0_1px_rgba(82,82,82,0.42)]'
        )}
        aria-label={variantLabel}
        onClick={(e) => onTitleVariantFocus(e, variant)}
        onMouseEnter={() => onTitleVariantMouseEnter(variant)}
        onMouseLeave={onTitleVariantMouseLeave}
        onFocus={() => onTitleVariantFocusIn(variant)}
        onBlur={onTitleVariantBlur}
      >
        {labelContent}
      </button>
    )
    const variantFocusTarget = variantCanToggleSaved ? (
      <ContextMenu>
        <ContextMenuTrigger render={variantFocusButton} />
        <PageChipContextMenuContent
          savedActionLabel={variantSavedActionLabel}
          saved={!!variant.saved}
          onSavedSelect={(e) => onToggleSavedTitleVariant(e, variant)}
          titleText={variantTitleText}
          onCopyTitle={(e) => onCopyTitleText(e, variantTitleText)}
        />
      </ContextMenu>
    ) : (
      variantFocusButton
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={variant.rawUrl || variant.tabUrl}
          className="chip-title-variant inline-flex max-w-full items-center gap-1 rounded-lg bg-[rgba(115,115,115,0.08)] px-1.5 py-0.5 text-xs leading-tight font-medium text-tab-muted [corner-shape:squircle]"
        >
          {labelContent}
        </span>
      )
    }

    return (
      <span
        key={variant.rawUrl || variant.tabUrl}
        className={cn(
          'chip-title-variant-shell group/title-variant relative flex w-full max-w-full min-w-0 items-center',
          variantActionCount === 1 && 'pr-[22px]',
          variantActionCount > 1 && 'pr-[42px]'
        )}
      >
        {variantFocusTarget}
        {variantActionCount > 0 && (
          <span className="chip-title-variant-actions absolute top-0 right-0 bottom-0 z-[2] my-auto flex h-[19px] items-center gap-0.5">
            {variantShowSavedHint && (
              <TooltipAnchor content="Saved page">
                <span
                  className="chip-title-variant-saved-hint pointer-events-none inline-flex size-[19px] cursor-default items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--accent-amber)] opacity-0 group-hover/title-variant:pointer-events-auto group-hover/title-variant:opacity-100"
                  aria-hidden="true"
                >
                  <SavedPageIcon saved className="size-3.5" />
                </span>
              </TooltipAnchor>
            )}
            {variantCanClose && (
              <button
                type="button"
                className="chip-title-variant-action inline-flex size-[19px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 group-hover/title-variant:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:text-tab-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]"
                aria-label={titleVariantActionLabel(variant)}
                onClick={(e) => onCloseTitleVariant(e, variant)}
                onMouseEnter={() => onTitleVariantMouseEnter(variant)}
                onMouseLeave={onTitleVariantMouseLeave}
                onFocus={() => onTitleVariantFocusIn(variant)}
                onBlur={onTitleVariantBlur}
              >
                <svg className="size-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </span>
        )}
      </span>
    )
  }

  function titleVariantListNode(mode: ChipTextRenderMode) {
    if (!isTitleVariantGroup) return null
    return (
      <span className="chip-title-variant-list flex w-full max-w-full flex-col items-stretch gap-0.5">
        {titleVariantChips.map((variant, index) => titleVariantNode(variant, index, mode))}
      </span>
    )
  }

  function titleVariantTitleRowNode(mode: ChipTextRenderMode) {
    return (
      <span className="chip-title-row block min-w-0 max-w-full">
        {chip.leadPrefix && (
          <span className="chip-subdomain mr-1.5 font-medium text-tab-muted after:ml-1.5 after:opacity-50 after:content-['·']">
            {highlightedTextNodes(chip.leadPrefix, highlightTerms, `${mode}-lead`)}
          </span>
        )}
        {titleContentNode(mode)}
      </span>
    )
  }

  function chipTextContentNode(mode: ChipTextRenderMode) {
    if (isFolded) {
      return (
        <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
          <span className="chip-title-row block min-w-0 max-w-full">
            {titleContentNode(mode)}
          </span>
          <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
            {envs.map((env) => envLabelNode(env, mode))}
          </span>
        </span>
      )
    }

    if (isTitleVariantGroup) {
      return (
        <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
          {titleVariantTitleRowNode(mode)}
          {titleVariantListNode(mode)}
        </span>
      )
    }

    return (
      <>
        {chip.leadPrefix && (
          <span className="chip-subdomain mr-1.5 font-medium text-tab-muted after:ml-1.5 after:opacity-50 after:content-['·']">
            {highlightedTextNodes(chip.leadPrefix, highlightTerms, `${mode}-lead`)}
          </span>
        )}
        {titleContentNode(mode)}
      </>
    )
  }

  function splitChipTooltipLinesNode() {
    const lastIndex = chipTooltipLineHtml.length - 1
    return (
      <span className={PAGE_CHIP_TOOLTIP_LINES_CLASS_NAME}>
        {chipTooltipLineHtml.map((html, index) => (
          <span
            key={`${index}:${html}`}
            className={index === lastIndex ? PAGE_CHIP_TOOLTIP_TAIL_LINE_CLASS_NAME : chipTooltipViewportConstrained ? PAGE_CHIP_TOOLTIP_CONSTRAINED_LINE_CLASS_NAME : PAGE_CHIP_TOOLTIP_LINE_CLASS_NAME}
          >
            {tooltipLineNodesFromHtml(html, `line-${index}`)}
          </span>
        ))}
      </span>
    )
  }

  function regularChipTooltipContentNode() {
    if (chipTooltipLineHtml.length === 0) return chipTextContentNode('tooltip')
    return splitChipTooltipLinesNode()
  }

  function foldedChipTooltipContentNode() {
    return (
      <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
        <span className="chip-title-row block min-w-0 max-w-full">
          {chipTooltipLineHtml.length > 0 ? splitChipTooltipLinesNode() : titleContentNode('tooltip')}
        </span>
      </span>
    )
  }

  function titleVariantChipTooltipContentNode() {
    return (
      <span className="chip-title-variant-content flex min-w-0 flex-col items-start gap-0.5">
        {chipTooltipLineHtml.length > 0 ? (
          <span className="chip-title-row block min-w-0 max-w-full">
            {splitChipTooltipLinesNode()}
          </span>
        ) : titleVariantTitleRowNode('tooltip')}
      </span>
    )
  }

  const chipTooltipContent = shouldShowChipTooltip ? (
    <span
      className={cn(
        "chip-text block min-w-0 max-w-[calc(100vw-32px)] whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [hyphenate-character:''] [overflow-wrap:break-word]",
        regularChipTooltipWidth
          ? 'w-[var(--page-chip-tooltip-width)]'
          : chipTooltipTextWidth && !isFolded && !isTitleVariantGroup && 'w-[var(--page-chip-tooltip-text-width)]',
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]'
      )}
      style={chipTooltipTextStyle}
    >
      {isFolded ? foldedChipTooltipContentNode() : isTitleVariantGroup ? titleVariantChipTooltipContentNode() : isRegularTitleTooltip ? regularChipTooltipContentNode() : chipTextContentNode('tooltip')}
    </span>
  ) : undefined

  const chipTooltipMeasureElement = isRegularTitleTooltip && typeof window !== 'undefined' ? (
    <span
      ref={chipTooltipMeasureRef}
      className={cn(
        "page-chip-tooltip-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [hyphenate-character:''] [overflow-wrap:break-word]",
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]'
      )}
      aria-hidden="true"
    >
      {regularChipTooltipContentNode()}
    </span>
  ) : null

  const foldedTitleTooltipTriggerElement = (
    <span
      className="chip-text-tooltip-hit-area -my-[5px] flex min-w-0 py-[5px]"
      onPointerEnter={onChipTextTooltipHitAreaPointerEnter}
    >
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleContentNode('chip')}
      </span>
    </span>
  )

  const foldedChipTextContent = (
    <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
      {chipTooltipContent ? (
        <TooltipAnchor
          alignOffset={0}
          anchor={getChipTooltipAnchor}
          anchorToCursor={false}
          content={chipTooltipContent}
          className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word]"
          instant
          onOpenChange={setChipTooltipOpen}
          sideOffset={0}
          style={chipTooltipStyle}
        >
          {foldedTitleTooltipTriggerElement}
        </TooltipAnchor>
      ) : (
        <span className="chip-title-row block min-w-0 max-w-full">
          {titleContentNode('chip')}
        </span>
      )}
      <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
        {envs.map((env) => envLabelNode(env, 'chip'))}
      </span>
    </span>
  )

  const titleVariantTitleTooltipTriggerElement = (
    <span
      className="chip-text-tooltip-hit-area -my-[5px] flex min-w-0 py-[5px]"
      onPointerEnter={onChipTextTooltipHitAreaPointerEnter}
    >
      {titleVariantTitleRowNode('chip')}
    </span>
  )

  const titleVariantChipTextContent = (
    <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
      {chipTooltipContent ? (
        <TooltipAnchor
          alignOffset={0}
          anchor={getChipTooltipAnchor}
          anchorToCursor={false}
          content={chipTooltipContent}
          className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word]"
          instant
          onOpenChange={setChipTooltipOpen}
          sideOffset={0}
          style={chipTooltipStyle}
        >
          {titleVariantTitleTooltipTriggerElement}
        </TooltipAnchor>
      ) : (
        titleVariantTitleRowNode('chip')
      )}
      {titleVariantListNode('chip')}
    </span>
  )

  const chipTextElement = (
    <span
      className={cn(
        "chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:''] [&.chip-text-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(100%_-_60px),rgba(0,0,0,0.35)_calc(100%_-_20px),transparent)]",
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]',
        chip.pathSuffix && 'max-h-[calc(3lh)]',
        isTitleVariantGroup && 'max-h-none',
        isFolded && 'max-h-none'
      )}
      ref={chipTextRef}
      onPointerEnter={onChipTextPointerEnter}
    >
      {isFolded ? foldedChipTextContent : isTitleVariantGroup ? titleVariantChipTextContent : chipTextContentNode('chip')}
    </span>
  )

  const chipTextTooltipTriggerElement = (
    <span
      className="chip-text-tooltip-hit-area -my-[5px] flex min-w-0 flex-1 py-[5px]"
      onPointerEnter={onChipTextTooltipHitAreaPointerEnter}
    >
      {chipTextElement}
    </span>
  )

  const chipInteractionProps = parentInteractive
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: onFocus,
        onKeyDown: onChipKeyDown,
        onMouseEnter: onChipMouseEnter,
        onMouseLeave: onChipMouseLeave,
        onFocus: onChipFocus,
        onBlur: onChipBlur
      } as const
    : {}

  const chipElement = (
      <div
        className={cn(
          "page-chip group/page-chip relative flex items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [corner-shape:squircle] transition-[color,box-shadow] duration-100 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[var(--chip-hover-fade-width)] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_34%,var(--chip-hover-fade-bg)_100%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:[transform:scale(0.96)] motion-reduce:[&.closing]:transform-none",
          parentInteractive && 'clickable cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)]',
          chipTooltipOpen && 'page-chip-tooltip-open',
          !isClosedSavedPage && !isFolded && !isTitleVariantGroup && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.13)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.13)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.13)] [&:has(.chip-actions):hover::after]:opacity-100 [&.page-chip-context-menu-open:has(.chip-actions)::after]:opacity-100 [&.page-chip-tooltip-open:has(.chip-actions)::after]:opacity-100',
          isClosedSavedPage && !isFolded && !isTitleVariantGroup && 'page-chip-saved-closed text-tab-muted opacity-75 hover:bg-[rgba(82,82,82,0.06)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.06)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.06)] [&:has(.chip-actions):hover::after]:opacity-100 [&.page-chip-context-menu-open:has(.chip-actions)::after]:opacity-100 [&.page-chip-tooltip-open:has(.chip-actions)::after]:opacity-100',
          hasActiveChipFrame && !isCurrentActiveFrame && 'bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)]',
          isCurrentActiveFrame && 'current-active-chip bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400',
          hasActiveChipFrame && !isFolded && !isTitleVariantGroup && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.18)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.18)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.18)]',
          isTitleVariantGroup && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.05)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.05)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.05)]',
          isFolded && !hasActiveChipFrame && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.05)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.05)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.05)]',
          isFolded && hasActiveChipFrame && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.11)] [&.page-chip-context-menu-open]:bg-[rgba(82,82,82,0.11)] [&.page-chip-tooltip-open]:bg-[rgba(82,82,82,0.11)]',
          isFolded && 'page-chip-folded cursor-default after:hidden',
          chip.saved && 'page-chip-saved',
          hoverMatched && 'page-chip-hover-match',
          suppressionHighlighted && cn('page-chip-suppression-highlighted', titleSuppressionChipHighlightClass(activeSuppressionTone)),
          chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 overflow-hidden rounded-xl border-0 bg-transparent p-0 [corner-shape:squircle] [outline:1px_solid_rgba(115,115,115,0.18)] outline-offset-[1px] before:hidden after:hidden',
          chip.iconOnly && chip.isApp && 'overflow-visible outline-none',
          chip.iconOnly && hasActiveChipFrame && 'bg-[rgba(82,82,82,0.075)] [outline:1px_solid_rgba(82,82,82,0.32)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]'
        )}
        aria-label={chipLabel}
        style={style}
        {...chipInteractionProps}
      >
      {hasActiveChipFrame && !chip.iconOnly && (
        <span
          className={cn(
            'active-chip-frame pointer-events-none absolute inset-0 z-[2] rounded-[inherit] [corner-shape:squircle]',
            isCurrentActiveFrame
              ? 'current-active-chip-frame shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)]'
              : 'shadow-[inset_0_0_0_1px_rgba(115,115,115,0.2)]'
          )}
          aria-hidden="true"
        />
      )}
      {showFaviconFrame && (
        <span
          className={cn(
            'chip-favicon-frame group/favicon-frame relative grid size-4 shrink-0 place-items-center',
            chip.isApp && 'is-app box-border h-6 w-6 rounded-xl border border-[rgba(115,115,115,0.32)] p-1 [corner-shape:squircle]'
          )}
        >
          <span
            className={cn(
              'chip-favicon-content grid h-full w-full place-items-center',
              showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0'
            )}
            aria-hidden="true"
          >
            {chip.faviconUrl ? (
              <img className="chip-favicon block h-full w-full rounded-none object-cover" src={chip.faviconUrl} alt="" />
            ) : showDefaultFavicon ? (
              <DefaultFavicon />
            ) : null}
          </span>
          {!chip.iconOnly && dupeCount > 1 && (
            <span
              className={cn(
                'chip-dupe-badge pointer-events-none absolute -top-[7px] -right-[7px] z-1 box-border inline-flex size-4 min-w-4 items-start justify-center rounded-full border-2 border-tab-card bg-[var(--accent-amber)] px-0 pt-px text-[9px] leading-none font-bold tabular-nums text-tab-card shadow-[0_1px_2px_rgba(10,10,10,0.18)] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-[ease]',
                showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
                dupeCount > 9 && 'chip-dupe-badge-wide w-auto rounded-lg px-1 [corner-shape:squircle]',
                dedupeBadgesClosing && 'closing'
              )}
              aria-hidden="true"
            >
              {dupeCount}
            </span>
          )}
          {showFaviconCloseAction && (
            <button
              type="button"
              className="chip-action chip-close chip-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-[2] inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 group-hover/favicon-frame:pointer-events-auto group-hover/favicon-frame:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:text-tab-ink hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--card-bg)] focus-visible:text-tab-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]"
              aria-label={closeActionLabel}
              onClick={isHistorySource ? onDeleteHistory : onClose}
            >
              <X className="size-[15px]" strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      {!chip.iconOnly && (
        isFolded || isTitleVariantGroup ? chipTextElement : chipTooltipContent ? (
          <TooltipAnchor
            alignOffset={0}
            anchor={getChipTooltipAnchor}
            anchorToCursor={false}
            content={chipTooltipContent}
            className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word] cursor-default select-none"
            instant
            onClick={parentInteractive ? onPageChipTooltipClick : undefined}
            onOpenChange={setChipTooltipOpen}
            sideOffset={0}
            style={chipTooltipStyle}
          >
            {chipTextTooltipTriggerElement}
          </TooltipAnchor>
        ) : chipTextElement
      )}
      {chipTooltipMeasureElement}
      {!chip.iconOnly && showSavedHint && (
        <div className="chip-actions absolute top-1/2 right-2 z-[2] flex -translate-y-1/2 items-center gap-0.5">
          <TooltipAnchor content="Saved page">
            <span
              className="chip-action chip-saved-hint pointer-events-none inline-flex shrink-0 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-1 text-[var(--accent-amber)] opacity-0 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 group-[.page-chip-context-menu-open]/page-chip:pointer-events-auto group-[.page-chip-context-menu-open]/page-chip:opacity-100 group-[.page-chip-tooltip-open]/page-chip:pointer-events-auto group-[.page-chip-tooltip-open]/page-chip:opacity-100"
              aria-hidden="true"
            >
              <SavedPageIcon saved className="size-[14px]" />
            </span>
          </TooltipAnchor>
        </div>
      )}
      </div>
  )
  const chipElementWithContextMenu = !chip.iconOnly && canToggleSavedPage ? (
    <PageChipContextMenu
      savedActionLabel={savedActionLabel}
      saved={!!chip.saved}
      onSavedSelect={onToggleSavedPage}
      titleText={chipTitleText}
      onCopyTitle={(e) => onCopyTitleText(e, chipTitleText)}
      onOpenChange={onChipContextMenuOpenChange}
    >
      {chipElement}
    </PageChipContextMenu>
  ) : chipElement

  if (chip.iconOnly && chipTooltipContent) {
    return (
      <TooltipAnchor
        content={chipTooltipContent}
        className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word] cursor-default select-none"
        instant
        onClick={onPageChipTooltipClick}
        onOpenChange={setChipTooltipOpen}
        style={chipTooltipStyle}
      >
        {chipElement}
      </TooltipAnchor>
    )
  }

  return chipElementWithContextMenu
}

export function PageChip(props: PageChipProps) {
  return usePageChipElement(props)
}
