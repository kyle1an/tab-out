import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { X } from 'lucide-react'
import { isClosedSavedDashboardTab, isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { savePageTarget, removeSavedPageTarget } from '../extension/saved-page-actions.js'
import { focusExistingTabTarget } from '../extension/tab-focus.js'
import { moveTabToCurrentWindow, moveTabToNewWindow } from '../extension/tab-move.js'
import { focusExactTab, focusTab, openTabUrl, openTabUrlInNewWindow } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls, setChipTargetMuted, suspendChipTarget } from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'
import { nextMutedForAudioState } from '../extension/tab-audio.js'
import { DefaultFavicon } from './DefaultFavicon'
import { useDomainCardContext } from './DomainCardContext'
import { useDashboardActions, useHoverState } from './DashboardInteractionContext'
import { startPageChipCloseAnimation } from './PageChipCloseAnimation'
import { TooltipAnchor } from './ui/tooltip'
import { PageChipContextMenu } from './PageChipContextMenu'
import { SavedPageIcon } from './SavedPageIcon'
import { TabAudioButton } from './TabAudioButton'
import { TabLoadingIndicator } from './TabLoadingIndicator'
import { cn } from '@/lib/utils'
import type { CSSVariableProperties } from '@/lib/css-properties'
import { createBionicTitleTextRenderer, isUrlLikeTitle } from './bionic-title-text'
import { highlightTermsForFilter, highlightedTextNodes } from './filter-highlight-text'
import { titleSuppressionChipHighlightClass, titleSuppressionMarkerClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import { chipActivationMode, shouldSuppressSelectionForGesture } from './chip-activation'
import type { ChipActivationModifiers } from './chip-activation'
import { clampedTitleLineNodes, createExpansionMeasureElement, createTitleExpansionLane, expandedLineContentOverflows, expansionLineHtmlEquals, expansionLineMarkup, expansionLineNodesFromHtml, fragmentHtml, paintedRangeRect, searchExpandedWidth, syncTruncatedTitleFadeEnd, unwrapClampedTitleLines, useTitleExpansionController, type ExpansionLineClasses } from './title-expansion'
import { chipTrim, CHIP_TRIM_TOKENS } from './chip-trim'
import { FAVICON_DIM_CLASS_NAME, VARIANT_LABEL_DIM_CLASS_NAME } from './liveness-dim'
import type { DashboardChipData } from './types'
import type { DashboardChipEnv, DashboardSegment } from '../extension/types'
import { closeTargetLeavesSavedPage, partitionVariantCloseTargets, groupCloseActionLabel, variantClosable } from './chip-close-targets.js'
import { chipCanShowSuspend, chipSuspendableTargetCount } from './chip-suspend-targets.js'

let chipTextResizeObserver: ResizeObserver | null = null
const chipTextTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: { hasExpandableContent: boolean; height: number; isTruncated: boolean; width: number }) => void
>()

const PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX = 12
const PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX = 8
const CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX = 0.5
const PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS = 12
const PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX = 1.5
const PAGE_CHIP_EXPANDED_CLOSE_DELAY_MS = 160
// While expanded, the chip floats wider/taller than its original slot. Keep it open
// until the pointer leaves the EXPANDED chip (plus this small grace margin) so the
// pointer can travel onto the revealed content without the chip blinking shut at the
// seam between the original footprint and the revealed overflow.
const PAGE_CHIP_EXPANDED_POINTER_LEAVE_TOLERANCE_PX = 6
const PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0 bg-[rgba(115,115,115,0.08)] px-1 text-[12px] leading-[inherit] font-medium whitespace-nowrap text-tab-muted align-baseline [corner-shape:squircle] [-webkit-box-decoration-break:clone] [box-decoration-break:clone]'
const PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME = 'chip-strip-indicator inline-block max-w-full rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium whitespace-nowrap text-tab-muted align-baseline [corner-shape:squircle]'
// Expanded chips reveal the full path suffix, so the cloned/measured copy must
// wrap (and break long, space-free query strings) instead of staying on the
// single nowrap line it uses while collapsed — otherwise it overflows the chip.
const PAGE_CHIP_EXPANDED_PATH_CLASS_NAME = 'chip-path font-normal text-tab-muted opacity-75 inline-block max-w-full whitespace-normal wrap-break-word'
const DEFAULT_CHIP_EXPANSION_GEOMETRY: ChipExpansionGeometry = {
  grewTaller: false,
  lineHtml: [],
  maxWidth: 0,
  viewportConstrained: false,
  width: 0,
  x: 'start',
  y: 'down'
}

interface PageChipProps {
  chip: DashboardChipData
  filter?: string
  layoutScope?: string
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
}

type ChipTextRenderMode = 'chip' | 'tooltip'
type RenderTitleContentOptions = {
  includePathSuffix?: boolean
}
type StopPropagationEvent = {
  stopPropagation: () => void
}
type ChipTextMetrics = {
  hasExpandableContent: boolean
  isTruncated: boolean
  width: number
}
type ChipTextClamp = {
  key: string
  lineHtml: string[]
  width: number
}
type ChipSlotSize = {
  height: number
  width: number
}
type ChipExpansionGeometry = {
  /** The expansion wraps to MORE lines than the resting chip, so the overlay
      extends past the resting slot instead of revealing in place. */
  grewTaller: boolean
  lineHtml: string[]
  maxWidth: number
  viewportConstrained: boolean
  width: number
  x: 'start'
  y: 'down' | 'up'
}
type ChipExpansionDomPosition =
  | {
    kind: 'text'
    node: Text
    offset: number
  }
  | {
    element: HTMLElement
    kind: 'element'
  }
type ExpandedPageChipContentMetrics = {
  /** True only when a single-line resting title must WRAP on reveal — the
      expanded overlay then grows taller than the resting slot. Multi-line
      resting chips reveal in place (frozen lines), so they never set this. */
  grewTaller?: boolean
  viewportConstrained: boolean
  width: number
}
const DEFAULT_CHIP_TEXT_METRICS: ChipTextMetrics = { hasExpandableContent: false, isTruncated: false, width: 0 }
const DEFAULT_CHIP_SLOT_SIZE: ChipSlotSize = { height: 0, width: 0 }

const pageChipExpansionLane = createTitleExpansionLane()

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function titleTextForChip(target: Pick<DashboardChipData, 'title' | 'tooltip' | 'tabUrl'>): string {
  return (target.title || target.tooltip || target.tabUrl).trim()
}

function titleTextForEnv(env: DashboardChipEnv, parent: Pick<DashboardChipData, 'title' | 'tooltip'>): string {
  return (env.title || parent.title || parent.tooltip || env.tabUrl).trim()
}

function isTitleSuppressionSegment(segment: DashboardSegment): segment is { titleSuppression: string } {
  return typeof segment !== 'string' && 'titleSuppression' in segment
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true; label?: string } {
  return typeof segment !== 'string' && 'placeholder' in segment
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

function getChipTextPaintedContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return 0

  const textRect = textEl.getBoundingClientRect()
  if (textRect.width <= 0) return 0

  const range = ownerDocument.createRange()
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent?.trim()
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  let maxRight = 0

  function includeRect(rect: DOMRect) {
    if (rect.width <= 0 && rect.height <= 0) return
    maxRight = Math.max(maxRight, rect.right - textRect.left)
  }

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) includeRect(rect)
    }
  } finally {
    range.detach()
  }

  for (const marker of Array.from(textEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator'))) {
    includeRect(marker.getBoundingClientRect())
  }

  return Math.round(Math.max(0, maxRight) * 100) / 100
}

function getChipTextExpansionBaselineWidth(textEl: HTMLElement | null) {
  const boxWidth = getChipTextWidth(textEl)
  const contentWidth = getChipTextPaintedContentWidth(textEl)
  if (boxWidth <= 0 || contentWidth <= 0) return boxWidth
  return Math.round(Math.min(boxWidth, contentWidth + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX) * 100) / 100
}

function cssPixelValue(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function elementInlinePaddingWidth(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!styles) return 0
  return cssPixelValue(styles.paddingLeft) + cssPixelValue(styles.paddingRight)
}

function elementColumnGap(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  return styles ? cssPixelValue(styles.columnGap) : 0
}

function visibleElementChildren(element: HTMLElement) {
  return Array.from(element.children).filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false
    const rect = child.getBoundingClientRect()
    return rect.width > 0 || child.scrollWidth > 0
  })
}

function titleVariantButtonMinimumWidth(button: HTMLElement) {
  const children = visibleElementChildren(button)
  const contentWidth = children.reduce((width, child) => {
    if (child.classList.contains('chip-title-variant-label')) {
      return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
    }
    return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
  }, 0)
  const gapWidth = Math.max(0, children.length - 1) * elementColumnGap(button)
  return elementInlinePaddingWidth(button) + gapWidth + contentWidth
}

function getTitleVariantMinimumContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  let width = 0
  for (const shell of Array.from(textEl.querySelectorAll<HTMLElement>('.chip-title-variant-shell'))) {
    const button = shell.querySelector<HTMLElement>('.chip-title-variant')
    if (!button) continue
    const list = shell.closest<HTMLElement>('.chip-title-variant-list')
    const listInlinePadding = list ? elementInlinePaddingWidth(list) : 0
    width = Math.max(
      width,
      listInlinePadding + elementInlinePaddingWidth(shell) + titleVariantButtonMinimumWidth(button)
    )
  }
  return Math.round(width * 100) / 100
}

function titleVariantLabelsOverflow(textEl: HTMLElement | null) {
  if (!textEl) return false
  return Array.from(textEl.querySelectorAll<HTMLElement>('.chip-title-variant-label'))
    .some((label) => label.scrollWidth - label.clientWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX)
}

function titleVariantContentOverflows(textEl: HTMLElement | null) {
  const minimumWidth = getTitleVariantMinimumContentWidth(textEl)
  if (minimumWidth <= 0) return false
  const visibleWidth = getChipTextExpansionBaselineWidth(textEl)
  return minimumWidth - visibleWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX
}

function chipTextHasExpandableContent(textEl: HTMLElement | null) {
  return isChipTextTruncated(textEl) || titleVariantLabelsOverflow(textEl) || titleVariantContentOverflows(textEl)
}

function getChipTextHeight(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().height * 100) / 100
}

function getChipTextLineHeight(textEl: HTMLElement | null) {
  if (!textEl || typeof window === 'undefined') return 16
  const styles = window.getComputedStyle(textEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight

  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16
}

function getVisibleChipTextLineCount(textEl: HTMLElement | null) {
  if (!textEl) return 1
  const lineHeight = getChipTextLineHeight(textEl)
  const textHeight = getChipTextHeight(textEl)
  if (lineHeight <= 0 || textHeight <= 0) return 1
  return Math.max(1, Math.round(textHeight / lineHeight))
}

function chipExpansionLineIndexForRect(rect: DOMRect, textRect: DOMRect, lineHeight: number, visibleLineCount: number) {
  if (rect.width <= 0 && rect.height <= 0) return null
  const lineIndex = Math.max(0, Math.round((rect.top - textRect.top) / lineHeight))
  return lineIndex < visibleLineCount ? lineIndex : null
}

function setRangeStartAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setStart(position.node, position.offset)
    return
  }
  range.setStartBefore(position.element)
}

function setRangeEndAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setEnd(position.node, position.offset)
    return
  }
  range.setEndBefore(position.element)
}

function carriedExpandedMarkerToneClass(marker: Element) {
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

function carriedExpandedMarkerSpacingClass(marker: Element) {
  return Array.from(marker.classList)
    .filter((className) => className.startsWith('ml-') || className.startsWith('mr-'))
    .join(' ')
}

function ensureLeadingExpandedMarkerSpace(document: Document, marker: Element) {
  if (carriedExpandedMarkerSpacingClass(marker)) return
  const previous = marker.previousSibling
  if (previous?.textContent && /\s$/.test(previous.textContent)) return
  marker.before(document.createTextNode(' '))
}

function hydrateClonedExpandedChipFragment(document: Document, fragment: DocumentFragment) {
  for (const content of Array.from(fragment.querySelectorAll('.chip-title-variant-content'))) {
    content.className = 'chip-title-variant-content inline-flex max-w-full min-w-0 flex-col items-start gap-0.5 align-top'
  }

  for (const list of Array.from(fragment.querySelectorAll('.chip-title-variant-list'))) {
    list.className = 'chip-title-variant-list inline-flex max-w-full flex-col items-stretch pr-[5px] pb-1 align-top divide-y divide-neutral-500/15'
  }

  for (const shell of Array.from(fragment.querySelectorAll('.chip-title-variant-shell'))) {
    shell.className = 'chip-title-variant-shell inline-flex max-w-full min-w-0 items-center'
  }

  for (const variant of Array.from(fragment.querySelectorAll('.chip-title-variant'))) {
    variant.className = 'chip-title-variant inline-flex max-w-full min-w-0 items-center gap-1 rounded-none bg-transparent px-1.5 py-[3px] [font-size:inherit] leading-tight font-normal text-neutral-600'
  }

  for (const marker of Array.from(fragment.querySelectorAll('.chip-title-suppression-marker'))) {
    const label = marker.getAttribute('aria-label') || ''
    const hiddenTitleText = label.replace(/^Suppressed title text:\s*/, '').trim()
    if (!hiddenTitleText) continue

    ensureLeadingExpandedMarkerSpace(document, marker)
    marker.className = cn(PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, carriedExpandedMarkerSpacingClass(marker), carriedExpandedMarkerToneClass(marker))
    marker.replaceChildren(document.createTextNode(hiddenTitleText))
  }

  for (const marker of Array.from(fragment.querySelectorAll('.chip-strip-indicator'))) {
    if (!marker.textContent?.trim()) {
      marker.remove()
      continue
    }

    const label = marker.getAttribute('aria-label') || ''
    if (!label) continue

    marker.className = PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME
    marker.replaceChildren(document.createTextNode(label))
  }

  for (const path of Array.from(fragment.querySelectorAll('.chip-path'))) {
    path.className = PAGE_CHIP_EXPANDED_PATH_CLASS_NAME
  }
}

function expandedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  hydrateClonedExpandedChipFragment(document, fragment)
  return fragmentHtml(document, fragment)
}

// Clamped rows keep the raw captured markup: markers stay as-is so the
// clamped-row renderer can rebuild them as live React nodes, instead of the
// expansion pipeline's hydrated text-label presentation.
function clampedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  return fragmentHtml(document, fragment)
}

function getClampedPageChipLineHtml(textEl: HTMLElement | null) {
  return getExpandedPageChipLineHtml(textEl, clampedChipFragmentHtml)
}

type ChipLineFragmentSerializer = (document: Document, fragment: DocumentFragment) => string

function getExpandedPageChipLineHtml(textEl: HTMLElement | null, serializeFragment: ChipLineFragmentSerializer = expandedChipFragmentHtml) {
  if (!textEl || typeof document === 'undefined') return []

  const visibleLineCount = getVisibleChipTextLineCount(textEl)
  if (visibleLineCount <= 1) return []

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const textRect = textEl.getBoundingClientRect()
  const lineHeight = getChipTextLineHeight(textEl)
  if (textRect.height <= 0 || lineHeight <= 0) return []

  // A compact marker glyph can be the first painted item on a wrapped line.
  // Treat those marker elements as line-start candidates so the expanded label
  // stays on the same visible line instead of jumping back into the prior text.
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT | win.NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof win.Text) {
          return node.textContent
            ? win.NodeFilter.FILTER_ACCEPT
            : win.NodeFilter.FILTER_REJECT
        }
        if (
          node instanceof win.HTMLElement &&
          (
            node.classList.contains('chip-title-suppression-marker') ||
            node.classList.contains('chip-strip-indicator')
          )
        ) {
          return win.NodeFilter.FILTER_ACCEPT
        }
        return win.NodeFilter.FILTER_SKIP
      }
    }
  )
  const range = ownerDocument.createRange()
  const lineStartsByIndex: Array<ChipExpansionDomPosition | undefined> = Array.from({ length: visibleLineCount })
  let capturedLineCount = 0

  while (capturedLineCount < visibleLineCount) {
    const node = walker.nextNode()
    if (!node) break

    if (node instanceof win.HTMLElement) {
      const lineIndex = chipExpansionLineIndexForRect(node.getBoundingClientRect(), textRect, lineHeight, visibleLineCount)
      if (lineIndex !== null && !lineStartsByIndex[lineIndex]) {
        lineStartsByIndex[lineIndex] = { element: node, kind: 'element' }
        capturedLineCount += 1
      }
      continue
    }

    if (!(node instanceof win.Text)) continue

    const text = node.data
    for (let offset = 0; offset < text.length && capturedLineCount < visibleLineCount; offset += 1) {
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      const rect = paintedRangeRect(range)
      if (!rect) continue

      const lineIndex = chipExpansionLineIndexForRect(rect, textRect, lineHeight, visibleLineCount)
      if (lineIndex === null) break
      if (!lineStartsByIndex[lineIndex]) {
        lineStartsByIndex[lineIndex] = { kind: 'text', node, offset }
        capturedLineCount += 1
      }
    }
  }

  range.detach()
  const lineStarts = lineStartsByIndex.filter((position): position is ChipExpansionDomPosition => !!position)
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    setRangeStartAtChipExpansionPosition(lineRange, start)
    const next = lineStarts[index + 1]
    if (next) {
      setRangeEndAtChipExpansionPosition(lineRange, next)
    } else {
      lineRange.selectNodeContents(textEl)
      setRangeStartAtChipExpansionPosition(lineRange, start)
    }
    lines.push(serializeFragment(ownerDocument, lineRange.cloneContents()))
    lineRange.detach()
  }

  return lines
}

const PAGE_CHIP_EXPANSION_LINE_CLASSES: ExpansionLineClasses = {
  wrapper: 'page-chip-expanded-lines block min-w-0 max-w-full',
  line: 'page-chip-expanded-line block min-w-0 max-w-full whitespace-nowrap',
  constrainedLine: 'page-chip-expanded-line page-chip-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word',
  tailLine: 'page-chip-expanded-line page-chip-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'
}

function chipExpansionLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  return expansionLineMarkup(lineHtml, PAGE_CHIP_EXPANSION_LINE_CLASSES, viewportConstrained)
}

function expandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const lineHeight = getChipTextLineHeight(measureEl)
  const height = measureEl.getBoundingClientRect().height
  const fixedLineOverflows = Array.from(measureEl.querySelectorAll<HTMLElement>('.page-chip-expanded-line:not(.page-chip-expanded-line-tail)'))
    .some((line) => expandedLineContentOverflows(line, PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX))
  const markerWrapsTaller = Array.from(measureEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator'))
    .some((marker) => marker.getBoundingClientRect().height > lineHeight + PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX)
  return !fixedLineOverflows && !markerWrapsTaller && height <= targetLineCount * lineHeight + PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX
}

function getExpandedSingleLineNaturalWidth(measureEl: HTMLElement) {
  const elements = [measureEl, ...Array.from(measureEl.querySelectorAll<HTMLElement>('*'))]
  for (const element of elements) {
    element.style.whiteSpace = 'nowrap'
  }
  const range = measureEl.ownerDocument.createRange()
  range.selectNodeContents(measureEl)
  try {
    return Math.round(Math.max(
      measureEl.scrollWidth,
      measureEl.getBoundingClientRect().width,
      range.getBoundingClientRect().width
    ) * 100) / 100
  } finally {
    range.detach()
  }
}

/** The expansion swaps glyph pills for full-text labels, growing the visible content itself. */
function expansionRevealsHydratingPills(textEl: HTMLElement) {
  return !!textEl.querySelector('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')
}

/**
 * Widest packed line when the hydrated content wraps at the full viewport
 * allowance — the shrink-to-fit width for viewport-constrained reveals.
 * Undoes the nowrap mutation getExpandedSingleLineNaturalWidth left on the
 * measure clone, so pills keep their own nowrap while text wraps again.
 */
function measureConstrainedPackedWidth(measureEl: HTMLElement, maxContentWidth: number) {
  measureEl.style.whiteSpace = 'normal'
  for (const element of Array.from(measureEl.querySelectorAll<HTMLElement>('*'))) {
    element.style.whiteSpace = ''
  }
  measureEl.style.width = `${Math.max(1, maxContentWidth)}px`
  return getChipTextPaintedContentWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
}

function expandedPageChipMeasureMarkup(textEl: HTMLElement, lineHtml: readonly string[]) {
  if (lineHtml.length > 0) return chipExpansionLineMarkup(lineHtml)

  const ownerDocument = textEl.ownerDocument
  const fragment = ownerDocument.createDocumentFragment()
  for (const child of Array.from(textEl.childNodes)) {
    fragment.append(child.cloneNode(true))
  }
  hydrateClonedExpandedChipFragment(ownerDocument, fragment)
  return fragmentHtml(ownerDocument, fragment)
}

function createExpandedPageChipMeasureElement(
  textEl: HTMLElement,
  lineHtml: readonly string[]
) {
  return createExpansionMeasureElement(textEl, {
    className: 'page-chip-expansion-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-(--ink) [font-family:inherit] [hyphenate-character:\'\'] wrap-break-word',
    markup: expandedPageChipMeasureMarkup(textEl, lineHtml)
  })
}

function getExpandedTitleVariantContentWidth(textEl: HTMLElement, visibleWidth: number, maxContentWidth: number) {
  const titleRow = textEl.querySelector<HTMLElement>('.chip-title-row')
  if (!titleRow) return null

  const measureEl = createExpandedPageChipMeasureElement(titleRow, [])
  if (!measureEl) return null

  try {
    const naturalTitleWidth = getExpandedSingleLineNaturalWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
    const width = Math.min(Math.max(visibleWidth, naturalTitleWidth), maxContentWidth)
    return {
      viewportConstrained: naturalTitleWidth - maxContentWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
      width: Math.round(width * 100) / 100
    }
  } finally {
    measureEl.remove()
  }
}

function getExpandedWrappedPageChipContentWidth(
  textEl: HTMLElement,
  measureEl: HTMLElement,
  visibleWidth: number,
  maxContentWidth: number,
  targetLineCount: number,
  lineHtml: readonly string[]
): ExpandedPageChipContentMetrics {
  // Try the resting width first: if the revealed content still fits within the resting
  // line count there, keep the resting width and don't grow (no guard padding). Flooring
  // the lower bound at the resting box width, rather than a painted-content estimate that
  // can fall below it, avoids widening a chip whose content already fits at its current
  // width. Only widen when it genuinely can't fit in the resting line count.
  const lowerBound = Math.min(maxContentWidth, Math.max(visibleWidth, getChipTextWidth(textEl)))
  return searchExpandedWidth({
    lowerBound,
    maxContentWidth,
    steps: PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS,
    guardPx: lineHtml.length > 0 ? PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX : 0,
    fits: (width) => expandedMeasureFitsLineCount(measureEl, width, targetLineCount)
  })
}

function getExpandedPageChipContentWidth(
  textEl: HTMLElement | null,
  lineHtml: readonly string[],
  maxContentWidth: number,
  visibleWidthOverride = 0
): ExpandedPageChipContentMetrics {
  if (!textEl) return { viewportConstrained: false, width: 0 }

  const visibleWidth = Math.max(getChipTextExpansionBaselineWidth(textEl), visibleWidthOverride)
  const targetLineCount = Math.max(getVisibleChipTextLineCount(textEl), lineHtml.length)
  if (visibleWidth <= 0 || maxContentWidth <= 0) return { viewportConstrained: false, width: visibleWidth }

  const titleVariantMetrics = textEl.querySelector('.chip-title-variant-content')
    ? getExpandedTitleVariantContentWidth(textEl, visibleWidth, maxContentWidth)
    : null
  if (titleVariantMetrics) return titleVariantMetrics

  const measureEl = createExpandedPageChipMeasureElement(textEl, lineHtml)
  if (!measureEl) return { viewportConstrained: false, width: visibleWidth }

  try {
    if (textEl.classList.contains('chip-title-row')) {
      if (targetLineCount > 1) {
        return getExpandedWrappedPageChipContentWidth(textEl, measureEl, visibleWidth, maxContentWidth, targetLineCount, lineHtml)
      }
      const naturalWidth = getChipTextPaintedContentWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
      const width = Math.min(Math.max(visibleWidth, naturalWidth), maxContentWidth)
      return {
        viewportConstrained: naturalWidth - maxContentWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
        width: Math.round(width * 100) / 100
      }
    }

    if (targetLineCount <= 1) {
      // Expand horizontally only as far as the revealed text needs to sit on one line.
      // The natural width comes from a measure clone, which can render a sub-pixel
      // narrower than the real expanded element; add the same guard the other width
      // paths use so the text isn't left 1px short and forced to wrap. If it can't
      // fit on one line even at the full available width (the screen edge), don't
      // widen a pure-text reveal at all — keep the resting width and let it wrap.
      // Hydrating pills void that rule: they grow the visible content itself, so
      // wrapping at the resting width re-strands pills mid-title; pack the wrap
      // at the full allowance instead and shrink the box to the widest line.
      const naturalWidth = getExpandedSingleLineNaturalWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
      if (naturalWidth > maxContentWidth) {
        if (!expansionRevealsHydratingPills(textEl)) {
          return { grewTaller: true, viewportConstrained: true, width: Math.round(Math.min(visibleWidth, maxContentWidth) * 100) / 100 }
        }
        const packedWidth = measureConstrainedPackedWidth(measureEl, maxContentWidth)
        return { grewTaller: true, viewportConstrained: true, width: Math.round(Math.min(Math.max(visibleWidth, packedWidth), maxContentWidth) * 100) / 100 }
      }
      return { viewportConstrained: false, width: Math.round(Math.min(maxContentWidth, Math.max(visibleWidth, naturalWidth)) * 100) / 100 }
    }

    return getExpandedWrappedPageChipContentWidth(textEl, measureEl, visibleWidth, maxContentWidth, targetLineCount, lineHtml)
  } finally {
    measureEl.remove()
  }
}

function getExpandedPageChipHorizontalInset(chipEl: HTMLElement, textEl: HTMLElement | null) {
  if (!textEl) return 0
  const chipRect = chipEl.getBoundingClientRect()
  const textRect = textEl.getBoundingClientRect()
  return Math.max(0, textRect.left - chipRect.left) + Math.max(0, chipRect.right - textRect.right)
}

function syncChipTextFade(textEl: HTMLElement | null) {
  if (!textEl) return { hasExpandableContent: false, height: 0, isTruncated: false, width: 0 }

  const isTruncated = isChipTextTruncated(textEl)
  const hasExpandableContent = isTruncated || titleVariantLabelsOverflow(textEl) || titleVariantContentOverflows(textEl)
  const width = getChipTextWidth(textEl)
  const height = getChipTextHeight(textEl)
  textEl.classList.toggle('chip-text-truncated', isTruncated)
  syncTruncatedTitleFadeEnd(textEl, isTruncated)
  chipTextTruncationCallbacks.get(textEl)?.({ hasExpandableContent, height, isTruncated, width })
  return { hasExpandableContent, height, isTruncated, width }
}

function getChipTextMetrics(textEl: HTMLElement | null): ChipTextMetrics {
  const { hasExpandableContent, isTruncated, width } = syncChipTextFade(textEl)
  return { hasExpandableContent, isTruncated, width }
}

function chipTextMetricsEqual(left: ChipTextMetrics, right: ChipTextMetrics) {
  return (
    left.hasExpandableContent === right.hasExpandableContent &&
    left.isTruncated === right.isTruncated &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function getPageChipExpansionGeometry(chipEl: HTMLElement | null, textEl: HTMLElement | null = chipEl?.querySelector<HTMLElement>('.chip-text') || null): ChipExpansionGeometry {
  if (!chipEl || typeof window === 'undefined') return DEFAULT_CHIP_EXPANSION_GEOMETRY

  const rect = chipEl.getBoundingClientRect()
  const contentBoxEl = chipEl.querySelector<HTMLElement>('.chip-text') || textEl
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
  const roomToRight = Math.max(0, viewportWidth - rect.left - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomBelow = Math.max(0, viewportHeight - rect.top - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomAbove = Math.max(0, rect.bottom - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const horizontalInset = getExpandedPageChipHorizontalInset(chipEl, contentBoxEl)
  const lineHtml = getExpandedPageChipLineHtml(textEl)
  const visibleWidthOverride = contentBoxEl && contentBoxEl !== textEl
    ? Math.max(getChipTextExpansionBaselineWidth(contentBoxEl), getTitleVariantMinimumContentWidth(contentBoxEl))
    : getTitleVariantMinimumContentWidth(textEl)
  const minWidth = Math.max(1, horizontalInset + Math.max(getChipTextExpansionBaselineWidth(textEl), visibleWidthOverride))
  const maxWidth = Math.max(rect.width, roomToRight)
  const contentMetrics = getExpandedPageChipContentWidth(textEl, lineHtml, Math.max(1, maxWidth - horizontalInset), visibleWidthOverride)
  return {
    grewTaller: !!contentMetrics.grewTaller,
    lineHtml,
    maxWidth,
    viewportConstrained: contentMetrics.viewportConstrained,
    width: Math.min(maxWidth, Math.max(rect.width, minWidth, contentMetrics.width + horizontalInset)),
    x: 'start',
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up'
  }
}

function roundedElementSize(element: HTMLElement | null): ChipSlotSize {
  if (!element) return DEFAULT_CHIP_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100
  }
}

function chipSlotSizeEqual(left: ChipSlotSize, right: ChipSlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function chipExpansionGeometryEqual(left: ChipExpansionGeometry, right: ChipExpansionGeometry) {
  return (
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml) &&
    left.x === right.x &&
    left.y === right.y &&
    left.viewportConstrained === right.viewportConstrained &&
    Math.abs(left.maxWidth - right.maxWidth) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function getChipTextResizeObserver() {
  if (!chipTextResizeObserver) {
    chipTextResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) syncChipTextFade(entry.target)
      }
    })
  }
  return chipTextResizeObserver
}

type ChipFaviconFrameProps = {
  chip: DashboardChipData
  dupeCount: number
  showDefaultFavicon: boolean
  showFaviconCloseAction: boolean
  dedupeBadgesClosing: boolean
  closeActionLabel: string
  onCloseAction: (e: MouseEvent<HTMLButtonElement>) => void
  onToggleAudio: () => void
}

/**
 * ChipFaviconFrame — the chip's favicon cell: dupe-stack layers, the favicon
 * (or default), the page-pin badge, the hover-revealed close action, and the
 * icon-only audio toggle. The favicon image dims when no live tab backs the
 * chip — the image itself, not the frame, so dupe-stack rings and badges
 * keep their weight.
 */
function ChipFaviconFrame({ chip, dupeCount, showDefaultFavicon, showFaviconCloseAction, dedupeBadgesClosing, closeActionLabel, onCloseAction, onToggleAudio }: ChipFaviconFrameProps) {
  const faviconDimmed = !!chip.suspended || isClosedSavedDashboardTab(chip)
  return (
    <span
      className={cn(
        'chip-favicon-frame group/favicon-frame relative grid size-4 shrink-0 place-items-center',
        chip.iconOnly ? 'self-center' : 'self-start',
        !chip.isApp && 'min-h-4 min-w-4 max-h-4 max-w-4',
        // Titled app chips ring their favicon with the same 20px ring as
        // history app rows, CENTERED on the plain favicon's 16px slot: the
        // symmetric negative margins keep a 16px layout footprint (title x
        // and chip height unchanged) while the ring overflows 2px on every
        // side, so its center-line sits on the same axis as plain favicons.
        chip.isApp && !chip.iconOnly && 'size-5 -mx-0.5 -my-0.5',
        !chip.iconOnly && dupeCount > 1 && 'chip-favicon-stack',
        chip.isApp && 'is-app'
      )}
    >
      {!chip.iconOnly && dupeCount > 2 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-0 size-4 max-h-4 max-w-4 translate-x-1 translate-y-1 rounded-[4px] bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.12)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing'
          )}
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && dupeCount > 1 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-1 size-4 max-h-4 max-w-4 translate-x-0.5 translate-y-0.5 rounded-[4px] bg-(--card-bg) ring-1 ring-neutral-300/55 shadow-[0_1px_2px_rgba(10,10,10,0.1)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing'
          )}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          'chip-favicon-content relative z-2 grid size-4 place-items-center',
          chip.isApp && !chip.iconOnly && 'chip-app-favicon-ring h-full w-full overflow-hidden rounded-[8px] border border-[rgba(115,115,115,0.32)] p-[2px] [corner-shape:squircle]',
          !chip.iconOnly && dupeCount > 1 && 'rounded-[4px] bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.08)] [corner-shape:squircle]',
          showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0'
        )}
        aria-hidden="true"
      >
        {chip.loading ? (
          <TabLoadingIndicator />
        ) : chip.faviconUrl ? (
          <img className={cn('chip-favicon block h-full w-full rounded-none object-cover', faviconDimmed && FAVICON_DIM_CLASS_NAME)} src={chip.faviconUrl} alt="" />
        ) : showDefaultFavicon ? (
          <DefaultFavicon className={faviconDimmed ? FAVICON_DIM_CLASS_NAME : ''} />
        ) : null}
      </span>
      {!chip.iconOnly && chip.pagePinned && (
        <span
          data-tabout-part="page-pin"
          data-pinned="true"
          className={cn(
            'chip-page-pin-badge pointer-events-none absolute -top-[6px] -right-[6px] z-3 inline-flex size-3.5 items-center justify-center rounded-full border border-tab-card bg-(--card-bg) text-tab-muted opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.16)] data-[pinned=true]:opacity-100',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0'
          )}
          aria-hidden="true"
        >
          <span className="icon-[lucide--pin] size-2.5" aria-hidden="true" />
        </span>
      )}
      {showFaviconCloseAction && (
        <button
          type="button"
          data-tabout-part="close-button"
          className="chip-action chip-close chip-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-4 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 group-hover/favicon-frame:pointer-events-auto group-hover/favicon-frame:opacity-100 hover:bg-neutral-600/10 hover:text-tab-ink hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-tab-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
          aria-label={closeActionLabel}
          onClick={onCloseAction}
        >
          <X className="size-[15px]" strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleAudio}
          className="absolute right-0 bottom-0 z-4 size-3.5 rounded-full bg-(--card-bg) shadow-[0_1px_2px_rgba(10,10,10,0.16)] [corner-shape:squircle]"
        />
      )}
    </span>
  )
}

function usePageChipElement({ chip, filter = '', layoutScope = '', suppressedTitleToneByText }: PageChipProps) {
  const { activeSuppressedTitle, dedupeBadgesClosing } = useDomainCardContext()
  const { url: activeHoverUrl, urls: activeHoverUrls, source: activeHoverSource } = useHoverState()
  const { onHoverUrlChange, onLayoutChange, onTogglePinnedPageChip } = useDashboardActions()
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const titleVariantChips = Array.isArray(chip.titleVariantChips) ? chip.titleVariantChips : []
  const isTitleVariantGroup = titleVariantChips.length > 1
  const chipLayoutKey = chip.pagePinId || chip.rawUrl
  const variantCloseTargets = partitionVariantCloseTargets(titleVariantChips)
  const variantCloseCount = variantCloseTargets.historyUrls.length + variantCloseTargets.tabEnvs.length
  const chipCloseLeavesSavedPage = isTitleVariantGroup
    ? titleVariantChips.some((variant) => variantClosable(variant) && closeTargetLeavesSavedPage(variant))
    : isFolded
      ? envs.some(closeTargetLeavesSavedPage)
      : closeTargetLeavesSavedPage(chip)
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
  const chipTextClampEligible = !chip.iconOnly && !isFolded && !isTitleVariantGroup
  const chipTextClampKey = JSON.stringify([chip.displaySegments, chip.leadPrefix ?? '', chip.pathGroupLabel ?? '', chip.pathSuffix ?? '', suppressedTitleParts, highlightTerms])
  const chipExpansionId = useId()
  const chipSlotRef = useRef<HTMLDivElement | null>(null)
  const chipTextRef = useRef<HTMLSpanElement | null>(null)
  const updateChipTextMeasurementsRef = useRef<(textEl: HTMLElement | null) => void>(() => {})
  const contextMenuOpenRef = useRef(false)
  const chipExpandedRef = useRef(false)
  const [chipTooltipOpen, setChipTooltipOpen] = useState(false)
  const [chipExpanded, setChipExpandedState] = useState(false)
  const [chipSlotSize, setChipSlotSize] = useState(DEFAULT_CHIP_SLOT_SIZE)
  const [chipExpansionGeometry, setChipExpansionGeometry] = useState(DEFAULT_CHIP_EXPANSION_GEOMETRY)
  const [chipTextMetrics, setChipTextMetrics] = useState(DEFAULT_CHIP_TEXT_METRICS)
  const [chipTextClamp, setChipTextClamp] = useState<ChipTextClamp | null>(null)
  const { hasExpandableContent } = chipTextMetrics

  const setChipExpanded = useCallback((nextExpanded: boolean) => {
    chipExpandedRef.current = nextExpanded
    setChipExpandedState(nextExpanded)
  }, [])

  // Page Chips keep an expansion open while their context menu is up: the
  // veto holds inside close (re-checked when a pending close fires) and
  // against lane steals, unlike history rows which guard at call sites.
  const chipExpansionController = useTitleExpansionController({
    id: chipExpansionId,
    lane: pageChipExpansionLane,
    closeDelayMs: PAGE_CHIP_EXPANDED_CLOSE_DELAY_MS,
    onExpandedChange: setChipExpanded,
    shouldCancelClose: () => contextMenuOpenRef.current,
    shouldIgnoreLaneSteal: () => contextMenuOpenRef.current
  })

  const updateChipTextMeasurements = useCallback((textEl: HTMLElement | null) => {
    const nextMetrics = getChipTextMetrics(textEl)
    setChipTextMetrics((current) => chipTextMetricsEqual(current, nextMetrics) ? current : nextMetrics)
  }, [])

  const updateChipSlotMeasurements = useCallback((chipElArg?: HTMLElement | null) => {
    const chipEl = chipElArg !== undefined ? chipElArg : chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null
    const nextSize = roundedElementSize(chipEl)
    const textEl = chipTextRef.current?.querySelector<HTMLElement>('.chip-title-row') || chipTextRef.current
    const nextGeometry = getPageChipExpansionGeometry(chipEl, textEl)
    setChipSlotSize((current) => chipSlotSizeEqual(current, nextSize) ? current : nextSize)
    setChipExpansionGeometry((current) => chipExpansionGeometryEqual(current, nextGeometry) ? current : nextGeometry)
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- callback reads only stable refs; eslint-plugin-react-hooks (the enforced gate) exempts refs.
  }, [])

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

  // Truncated chips swap to captured-line rows so the tail fills to the box
  // edge under the fade (see the matching history-title clamp effect for the
  // invalidate-then-recapture contract). The capture keeps marker elements
  // raw and the row renderer revives suppression pills as live React nodes,
  // so their glyph and hover tone survive the swap. Folded and variant-group
  // chips never clamp (their layouts are unclamped by design), and their
  // render branches ignore any clamp a prior eligible shape left behind.
  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl || chipExpandedRef.current) return

    const width = getChipTextWidth(textEl)
    if (chipTextClamp && (chipTextClamp.key !== chipTextClampKey || Math.abs(chipTextClamp.width - width) >= CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX)) {
      setChipTextClamp(null)
      return
    }
    if (chipTextClamp || width <= 0 || !chipTextClampEligible) return

    const metrics = syncChipTextFade(textEl)
    if (!metrics.isTruncated) return
    const lineHtml = getClampedPageChipLineHtml(textEl)
    if (lineHtml.length <= 1) return
    setChipTextClamp({ key: chipTextClampKey, lineHtml, width })
    // chipTextMetrics carries the observer-reported width, so width changes
    // re-run this effect even though the effect reads the live rect itself.
  }, [chipTextClamp, chipTextClampEligible, chipTextClampKey, chipTextMetrics])

  // The chip-text span REMOUNTS when shouldExpandChip flips (it moves inside
  // the expansion hit-area wrapper), so a mount-once registration would keep
  // observing the dead element and resize-driven metric updates would stop.
  // Re-register against the current element on every render instead.
  const observedChipTextElRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const textEl = chipTextRef.current
    const previous = observedChipTextElRef.current
    if (previous === textEl) return

    const observer = getChipTextResizeObserver()
    if (previous) {
      observer.unobserve(previous)
      chipTextTruncationCallbacks.delete(previous)
    }
    observedChipTextElRef.current = textEl
    if (!textEl) return

    chipTextTruncationCallbacks.set(textEl, ({ hasExpandableContent, isTruncated, width }) => {
      setChipTextMetrics((current) => {
        const nextMetrics = { hasExpandableContent, isTruncated, width }
        return chipTextMetricsEqual(current, nextMetrics) ? current : nextMetrics
      })
    })
    observer.observe(textEl)
  })

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the cleanup reads observedChipTextElRef at unmount time deliberately: it must unobserve whichever element is registered THEN, not the mount-time one.
  useEffect(() => {
    let disposed = false
    const fontSet = document.fonts
    const onFontsDone = () => {
      if (disposed) return
      setChipTextClamp(null)
      updateChipTextMeasurementsRef.current(chipTextRef.current)
    }
    fontSet.addEventListener('loadingdone', onFontsDone)
    fontSet.ready.then(onFontsDone)

    return () => {
      disposed = true
      fontSet.removeEventListener('loadingdone', onFontsDone)
      const observed = observedChipTextElRef.current
      if (observed) {
        getChipTextResizeObserver().unobserve(observed)
        chipTextTruncationCallbacks.delete(observed)
        observedChipTextElRef.current = null
      }
    }
  }, [])

  useLayoutEffect(() => {
    const chipEl = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null
    if (!chipEl) return

    if (!chipExpandedRef.current) updateChipSlotMeasurements(chipEl)

    const observer = new ResizeObserver(() => {
      if (!chipExpandedRef.current) updateChipSlotMeasurements(chipEl)
    })
    observer.observe(chipEl)
    return () => observer.disconnect()
  }, [updateChipSlotMeasurements])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function focusChipUrl(targetUrl: string | undefined, sourceTypeArg?: DashboardChipData['sourceType'], target?: Pick<DashboardChipData, 'rawUrl' | 'tabId'>) {
    const sourceType = sourceTypeArg !== undefined ? sourceTypeArg : chip.sourceType
    if (!targetUrl) return
    if (typeof target?.tabId === 'number') {
      const focused = await focusExistingTabTarget({ tabId: target.tabId, url: targetUrl, rawUrl: target.rawUrl })
      if (focused) return
    }
    if (isReadOnlyDashboardSourceType(sourceType)) {
      const focused = await focusExactTab(targetUrl)
      if (!focused) await openTabUrl(targetUrl)
      return
    }
    await focusTab(targetUrl)
  }

  async function activateChipTarget(
    e: ChipActivationModifiers | undefined,
    targetUrl: string | undefined,
    sourceType: DashboardChipData['sourceType'],
    target?: Pick<DashboardChipData, 'rawUrl' | 'tabId'>
  ) {
    if (!targetUrl) return
    const mode = chipActivationMode(e, navigator.platform)
    if (mode === 'focus') {
      await focusChipUrl(targetUrl, sourceType, target)
      return
    }
    if (mode === 'open-window') {
      const moved = await moveTabToNewWindow({ tabId: target?.tabId, tabUrl: targetUrl, rawUrl: target?.rawUrl })
      if (!moved) await openTabUrlInNewWindow(targetUrl)
      return
    }
    const activate = mode === 'bring-foreground'
    const moved = await moveTabToCurrentWindow({ tabId: target?.tabId, tabUrl: targetUrl, rawUrl: target?.rawUrl }, { activate })
    if (!moved) await openTabUrl(targetUrl, { active: activate })
  }

  function defaultTitleVariantChip() {
    if (!isTitleVariantGroup) return undefined
    return titleVariantChips.find((variant) => !!variant.activeChipFrame && !variant.activeInOtherWindow)
      || titleVariantChips.find((variant) => !!variant.activeInOtherWindow)
      || titleVariantChips[0]
  }

  function previewDefaultTitleVariant() {
    const variant = defaultTitleVariantChip()
    if (!variant) return
    setPreview(variant.tabUrl, previewUrlsForChip(variant))
  }

  function titleVariantEventTargetsExactVariant(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('.chip-title-variant, .chip-title-variant-actions, .chip-title-variant-action')
  }

  function titleVariantEventTargetsDefaultSurfaceBlocker(target: EventTarget | null) {
    if (!(target instanceof Element)) return false
    if (titleVariantEventTargetsExactVariant(target)) return true
    if (target.closest('[data-tabout-part="audio-toggle"]')) return true
    const faviconFrame = target.closest('.chip-favicon-frame')
    return !!faviconFrame?.querySelector('.chip-close-favicon')
  }

  function setDefaultVariantSurfaceHover(active: boolean) {
    chipSlotRef.current?.toggleAttribute('data-tabout-default-surface-hover', active)
  }

  function previewDefaultTitleVariantSurface(target: EventTarget | null) {
    if (titleVariantEventTargetsDefaultSurfaceBlocker(target)) {
      setDefaultVariantSurfaceHover(false)
      return false
    }
    setDefaultVariantSurfaceHover(true)
    previewDefaultTitleVariant()
    return true
  }

  async function onFocus(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    if (isFolded) return
    await activateChipTarget(e, chip.tabUrl, chip.sourceType, chip)
  }

  async function onPageChipTooltipClick(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!parentInteractive) return
    await onFocus(e)
  }

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus(e)
  }

  function onChipPointerDown(e: MouseEvent<HTMLDivElement>) {
    // Shift-click moves the tab into a new window; ⌘/⌃-click moves it into this window.
    // Cancel the browser's native text selection for those gestures only so the chip behaves
    // like a link (a plain click still drag-selects). See chip-activation.ts.
    if (shouldSuppressSelectionForGesture(e, navigator.platform)) e.preventDefault()
  }

  // The whole grouped-chip surface is the default-variant target: clicks on
  // the exact pills, their action rails, the favicon close, and the audio
  // toggle never reach these handlers (each stops propagation), so only
  // title/blank-surface clicks activate the default variant.
  async function onVariantGroupChipClick(e: MouseEvent<HTMLDivElement>) {
    if (titleVariantEventTargetsExactVariant(e.target)) return
    const variant = defaultTitleVariantChip()
    if (!variant) return
    await activateChipTarget(e, variant.tabUrl, variant.sourceType, variant)
  }

  function onVariantGroupChipMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (shouldSuppressSelectionForGesture(e, navigator.platform)) e.preventDefault()
  }

  function onVariantGroupChipMouseEnter(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseMove(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    if (chipExpandedRef.current) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType)
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
      openChipExpansion()
      setPreview(primaryPreviewUrl, previewUrlsForChip(chip))
      return
    }
    closeChipExpansion()
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

  function onTitleVariantContextMenuOpenChange(open: boolean, variant: DashboardChipData) {
    contextMenuOpenRef.current = open
    if (open) {
      setPreview(variant.tabUrl, previewUrlsForChip(variant))
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

  function openChipExpansion() {
    if (chip.iconOnly) return
    const textEl = chipTextRef.current
    const measuredExpandable = hasTitleSuppressionMarkers || hasStructuralPlaceholders || chipTextHasExpandableContent(textEl)
    if (!measuredExpandable) return
    // Only measure from the collapsed source DOM. Re-measuring while already
    // expanded feeds the hydrated expanded markers (whose suppressed text is now
    // a real text node) back into getExpandedPageChipLineHtml, which re-captures
    // the marker on two adjacent line ranges and duplicates it.
    if (!chipExpandedRef.current) {
      updateChipTextMeasurements(textEl)
      updateChipSlotMeasurements()
    }
    chipExpansionController.open()
  }

  function closeChipExpansion({ delayed = true } = {}) {
    chipExpansionController.close({ delayed })
  }

  useEffect(() => {
    if (!chipExpanded) return
    const closeNow = () => {
      chipExpansionController.closeNow()
    }
    const closeOnPointerMove = (event: globalThis.PointerEvent) => {
      if (contextMenuOpenRef.current) return
      // Measure the EXPANDED chip, not the original slot: the expanded chip floats
      // wider/taller than its 1:1 slot, so testing the slot rect collapsed the chip
      // the instant the pointer crossed into the revealed overflow — blinking it shut
      // at the border before the revealed content could be reached. Stay open while
      // the pointer is over the expanded chip (plus a small grace margin).
      const expandedChipEl = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip')
      const rect = expandedChipEl?.getBoundingClientRect() ?? chipSlotRef.current?.getBoundingClientRect()
      if (!rect) return
      const tolerance = PAGE_CHIP_EXPANDED_POINTER_LEAVE_TOLERANCE_PX
      const insideExpandedChip =
        event.clientX >= rect.left - tolerance &&
        event.clientX <= rect.right + tolerance &&
        event.clientY >= rect.top - tolerance &&
        event.clientY <= rect.bottom + tolerance
      if (!insideExpandedChip) closeNow()
    }
    const closeOnVisibilityChange = () => {
      if (document.hidden) closeNow()
    }
    window.addEventListener('blur', closeNow)
    window.addEventListener('pointermove', closeOnPointerMove, true)
    document.addEventListener('visibilitychange', closeOnVisibilityChange)
    return () => {
      window.removeEventListener('blur', closeNow)
      window.removeEventListener('pointermove', closeOnPointerMove, true)
      document.removeEventListener('visibilitychange', closeOnVisibilityChange)
    }
  }, [chipExpanded, chipExpansionController])

  function onChipTextPointerEnter(e: PointerEvent<HTMLSpanElement>) {
    updateChipTextMeasurements(e.currentTarget)
  }

  function onChipTooltipOpenChange(open: boolean) {
    setChipTooltipOpen(open)
  }

  function onChipFocus(e: FocusEvent<HTMLDivElement>) {
    if (isFolded) return
    if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) openChipExpansion()
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip))
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    closeChipExpansion({ delayed: false })
    setPreview('')
  }

  function onChipPointerLeave(e: PointerEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeChipExpansion()
  }

  function onChipPointerEnter() {
    openChipExpansion()
  }

  function isPointerInsideChipSlot(e: PointerEvent<HTMLDivElement>) {
    const slotRect = chipSlotRef.current?.getBoundingClientRect()
    if (!slotRect) return true
    return (
      e.clientX >= slotRect.left &&
      e.clientX <= slotRect.right &&
      e.clientY >= slotRect.top &&
      e.clientY <= slotRect.bottom
    )
  }

  function onChipPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (chipExpandedRef.current) return
    if (!isPointerInsideChipSlot(e)) return
    openChipExpansion()
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
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget

    await closeChipTarget({
      tabUrl: chip.tabUrl,
      tabId: chip.tabId,
      envs,
      onAfterClose: ({ shouldAnimateRemoval }) => {
        if (shouldAnimateRemoval && !chipCloseLeavesSavedPage && chipEl) {
          startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
        }
        setPreview('')
      }
    })
  }

  async function onDeleteHistory(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    const urls = Array.from(new Set(isFolded ? envs.flatMap((env) => env.tabUrl ? [env.tabUrl] : []) : chip.tabUrl ? [chip.tabUrl] : []))
    if (urls.length === 0) return

    await deleteHistoryUrls({
      urls,
      onAfterDelete: () => {
        startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
        setPreview('')
      }
    })
  }

  function onToggleChipAudio() {
    if (!chip.audioState) return
    void setChipTargetMuted({
      tabUrl: chip.tabUrl,
      envs: chip.envs,
      muted: nextMutedForAudioState(chip.audioState)
    })
  }

  function onToggleChipSuspend(e: StopPropagationEvent) {
    e.stopPropagation()
    void suspendChipTarget({ tabUrl: chip.tabUrl, envs: chip.envs })
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

  async function onTogglePagePin(e: StopPropagationEvent) {
    e.stopPropagation()
    if (!chip.pagePinId) return
    await onTogglePinnedPageChip?.(chip.pagePinId)
    onLayoutChange?.({ animate: true })
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

  async function onCopyUrlText(e: StopPropagationEvent, urlText: string) {
    e.stopPropagation()
    if (!urlText) return

    try {
      await navigator.clipboard.writeText(urlText)
      showToast('Page URL copied')
    } catch {
      showToast('Could not copy page URL')
    }
  }

  async function onTitleVariantFocus(e: MouseEvent<HTMLButtonElement>, variant: DashboardChipData) {
    e.stopPropagation()
    await activateChipTarget(e, variant.tabUrl, variant.sourceType, variant)
  }

  function onTitleVariantMouseEnter(variant: DashboardChipData) {
    setDefaultVariantSurfaceHover(false)
    setPreview(variant.tabUrl, previewUrlsForChip(variant))
  }

  function onTitleVariantMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      if (!titleVariantEventTargetsDefaultSurfaceBlocker(e.relatedTarget)) {
        previewDefaultTitleVariantSurface(e.relatedTarget)
      } else {
        setDefaultVariantSurfaceHover(false)
      }
      return
    }
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  function onTitleVariantFocusIn(variant: DashboardChipData) {
    setDefaultVariantSurfaceHover(false)
    setPreview(variant.tabUrl, previewUrlsForChip(variant))
  }

  function onTitleVariantBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) return
    setDefaultVariantSurfaceHover(false)
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
      tabId: variant.tabId,
      onAfterClose: async () => setPreview('')
    })
  }

  async function onCloseAllVariants(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    const { historyUrls, tabEnvs } = variantCloseTargets
    if (historyUrls.length === 0 && tabEnvs.length === 0) return

    // Close tabs and delete history without each call running its own removal
    // animation; animate the whole group chip out once, after both resolve.
    if (tabEnvs.length > 0) await closeChipTarget({ tabUrl: chip.tabUrl, envs: tabEnvs })
    if (historyUrls.length > 0) await deleteHistoryUrls({ urls: historyUrls })

    if (!chipCloseLeavesSavedPage && chipEl) startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
    setPreview('')
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

  async function onTogglePinnedTitleVariant(e: StopPropagationEvent, variant: DashboardChipData) {
    e.stopPropagation()
    if (!variant.pagePinId) return
    await onTogglePinnedPageChip?.(variant.pagePinId)
    onLayoutChange?.({ animate: true })
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

  const trim = chipTrim({
    activeChipFrame: !!chip.activeChipFrame,
    activeInOtherWindow: !!chip.activeInOtherWindow,
    isCurrentTabOut: !!chip.isCurrentTabOut,
    closedSavedPage: isClosedSavedPage,
    folded: isFolded,
    titleVariantGroup: isTitleVariantGroup,
    iconOnly: !!chip.iconOnly,
    isApp: !!chip.isApp,
    expanded: chipExpanded ? { grewTaller: chipExpansionGeometry.grewTaller, y: chipExpansionGeometry.y } : null
  })
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const loadingLabel = chip.loading ? 'Loading' : ''
  const pinnedLabel = chip.pagePinned ? 'Pinned' : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const savedLabel = chip.saved ? (isClosedSavedPage ? 'Closed saved page' : 'Saved page') : ''
  const hiddenTitleLabel = suppressedTitleParts.length > 0 ? `Suppressed title text: ${suppressedTitleParts.join(' · ')}` : ''
  const titleVariantLabel = isTitleVariantGroup ? `${titleVariantChips.length} URL variants: ${titleVariantChips.map((variant) => variant.pathSuffix || variant.tabUrl).join(' · ')}` : ''
  const chipLabel = [chip.tooltip, loadingLabel, pinnedLabel, titleVariantLabel, hiddenTitleLabel, duplicateLabel, activeLabel, savedLabel].filter(Boolean).join(' · ')
  const groupCloseCount = isTitleVariantGroup ? variantCloseCount : isFolded ? envs.length : 1
  const closeTargetsAllHistory = isTitleVariantGroup
    ? variantCloseTargets.tabEnvs.length === 0 && variantCloseTargets.historyUrls.length > 0
    : isHistorySource
  const closeActionLabel = groupCloseActionLabel({ count: groupCloseCount, allHistory: closeTargetsAllHistory })
  const savedActionLabel = chip.saved ? 'Remove saved page' : 'Save page'
  const pagePinActionLabel = chip.pagePinned ? 'Unpin' : 'Pin'
  const chipTitleText = titleTextForChip(chip)
  const chipUrlText = pageTargetUrl(chip)
  const canToggleSavedPage = parentInteractive && (chip.sourceType === 'tab' || chip.sourceType === 'saved-page') && !chip.isApp
  const canTogglePagePin = !!chip.pagePinId && typeof onTogglePinnedPageChip === 'function'
  // Unlike the other can* flags, canShowSuspend intentionally does NOT gate on
  // parentInteractive: folded groups (not parentInteractive) still expose Suspend.
  const canShowSuspend = chipCanShowSuspend(chip)
  const suspendEnabled = chipSuspendableTargetCount(chip) > 0
  const showSavedHint = parentInteractive && !!chip.saved && !canToggleSavedPage
  const canCloseChip = parentInteractive && !isClosedSavedPage && (!isReadOnlySource || isHistorySource)
  const canCloseFoldedGroup = isFolded && !isClosedSavedPage && (!isReadOnlySource || isHistorySource)
  const canCloseVariantGroup = isTitleVariantGroup && variantCloseCount > 0
  const canUseCopyContextMenu = parentInteractive && (!!chipTitleText || !!chipUrlText)
  const showFaviconCloseAction = !chip.iconOnly && (canCloseChip || canCloseFoldedGroup || canCloseVariantGroup)
  const showDefaultFavicon = !chip.faviconUrl && (!isReadOnlySource || chip.sourceType === 'saved-page')
  const showFaviconFrame = !!chip.faviconUrl || showDefaultFavicon || dupeCount > 1 || showFaviconCloseAction
  const rightActionCount = showSavedHint ? 1 : 0
  const chipHoverFadeWidth = rightActionCount === 0 ? '0px' : rightActionCount === 1 ? '56px' : '88px'
  const style: CSSVariableProperties = {
    '--chip-hover-fade-bg': trim.styleVars.fadeBg,
    '--chip-hover-fade-width': chipHoverFadeWidth,
    '--chip-hover-border': trim.styleVars.hoverBorder,
    '--chip-interaction-bg': trim.styleVars.interactionBg,
    '--chip-rest-bg': trim.styleVars.restBg,
    ...(chip.isGrouped ? { '--group-color': chip.groupDotColor ?? undefined } : {})
  }
  const hasTitleSuppressionMarkers = suppressedTitleParts.length > 0 || chip.displaySegments.some(isTitleSuppressionSegment)
  const hasStructuralPlaceholders = chip.displaySegments.some((segment) => isStructuralPlaceholderSegment(segment) && !!(segment.label || chip.pathGroupLabel))
  const shouldExpandChip = !chip.iconOnly && (hasExpandableContent || hasTitleSuppressionMarkers || hasStructuralPlaceholders)
  const chipVisualOpen = chipExpanded || chipTooltipOpen
  const chipSlotStyle: CSSVariableProperties | undefined = chipExpanded && chipSlotSize.width > 0 && chipSlotSize.height > 0 ? {
    height: `${chipSlotSize.height}px`,
    width: `${chipSlotSize.width}px`
  } : undefined
  const chipExpandedMaxWidth = chipExpansionGeometry.maxWidth > 0 ? `${chipExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const chipExpandedWidth = chipExpansionGeometry.width > 0 ? `${chipExpansionGeometry.width}px` : chipExpandedMaxWidth
  const chipStyle: CSSVariableProperties = {
    ...style,
    ...(chipExpanded ? {
      '--page-chip-expanded-max-width': chipExpandedMaxWidth,
      '--page-chip-expanded-width': chipExpandedWidth,
      maxWidth: chipExpandedMaxWidth,
      width: chipExpandedWidth
    } : {})
  }
  const chipTooltipStyle: CSSVariableProperties = {
    '--page-chip-tooltip-max-width': 'calc(100vw - 16px)',
    maxWidth: 'min(var(--page-chip-tooltip-max-width), calc(100vw - 16px))'
  }
  function chipMatchesActiveHover(target: DashboardChipData) {
    return (
      pageTargetMatchesHover(target, activeHoverUrl, activeHoverUrls) ||
      !!target.envs?.some((env) => (
        pageTargetMatchesHover(env, activeHoverUrl, activeHoverUrls)
      ))
    )
  }

  const externalHoverActive = !!activeHoverSource && activeHoverSource !== 'chip' && !!activeHoverUrl
  const hoverMatched = externalHoverActive && (
    chipMatchesActiveHover(chip) ||
    titleVariantChips.some((variant) => chipMatchesActiveHover(variant))
  )

  function suppressionMarkerNode(part: string, mode: ChipTextRenderMode, key: string, markerClassName = '') {
    const partKey = part.trim().toLowerCase()
    const active = activeSuppressedTitleKey !== '' && partKey === activeSuppressedTitleKey
    const tone = active ? activeSuppressionTone : titleSuppressionToneForText(part, suppressedTitleToneByText)
    const label = `Suppressed title text: ${part}`
    const marker = (
      <span
        key={key}
        className={cn(
          'chip-title-suppression-marker inline-flex h-[14px] min-w-[14px] shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-[rgba(115,115,115,0.08)] px-[3px] text-[12px] leading-[12px] text-tab-muted align-middle [corner-shape:squircle] group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:items-baseline group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:border-0 group-[.page-chip-expanded]/page-chip:px-1 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:font-medium group-[.page-chip-expanded]/page-chip:align-baseline group-[.page-chip-expanded]/page-chip:[-webkit-box-decoration-break:clone] group-[.page-chip-expanded]/page-chip:[box-decoration-break:clone]',
          markerClassName,
          titleSuppressionMarkerClass(tone, active)
        )}
        aria-label={label}
      >
        <svg className="chip-title-suppression-glyph h-[7px] w-2 group-[.page-chip-expanded]/page-chip:hidden" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.25 5.4c1.25-1.45 2.5-1.45 3.75 0s2.5 1.45 3.75 0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
        <span className="chip-title-suppression-label hidden group-[.page-chip-expanded]/page-chip:inline">
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
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

  function structuralPlaceholderNode(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabelArg?: string) {
    const fallbackLabel = fallbackLabelArg !== undefined ? fallbackLabelArg : chip.pathGroupLabel
    const hiddenLabel = segment.label || fallbackLabel
    const marker = (
      <span
        key={key}
        className="chip-strip-indicator inline-flex size-4 items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] text-xs leading-none font-medium text-tab-muted align-baseline group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:w-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:px-1.5 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:[corner-shape:squircle]"
        aria-hidden={hiddenLabel ? undefined : true}
        aria-label={hiddenLabel || undefined}
      >
        <span className={hiddenLabel ? 'chip-strip-indicator-glyph group-[.page-chip-expanded]/page-chip:hidden' : undefined}>/</span>
        {hiddenLabel && (
          <span className="chip-strip-indicator-label hidden group-[.page-chip-expanded]/page-chip:inline">
            {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
          </span>
        )}
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
      "chip-env inline-flex items-center rounded-lg border-0 bg-neutral-500/[0.045] px-1.5 text-xs leading-[inherit] font-medium text-tab-muted [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.']",
      isFolded && 'h-6 rounded-[7px] px-2',
      mode === 'chip' && 'clickable cursor-default transition-[background,color,box-shadow] duration-150 ease-[ease] hover:bg-neutral-600/[0.14] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) [&.page-chip-context-menu-open]:bg-neutral-600/[0.14] [&.page-chip-context-menu-open]:text-tab-ink',
      env.activeInOtherWindow && 'bg-neutral-600/[0.075] text-tab-ink shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]'
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
    const envCanUseContextMenu = canToggleSavedEnv || !!envTitleText || !!env.tabUrl
    const envFocusTarget = envCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={canToggleSavedEnv ? envSavedActionLabel : undefined}
        saved={!!env.saved}
        onSavedSelect={canToggleSavedEnv ? (e) => onToggleSavedEnv(e, env) : undefined}
        titleText={envTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, envTitleText)}
        urlText={env.tabUrl}
        onCopyUrl={(e) => onCopyUrlText(e, env.tabUrl)}
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
            className="chip-env-saved-hint pointer-events-none absolute -top-1.5 -right-1.5 z-2 inline-flex size-4 cursor-default items-center justify-center rounded-full border border-tab-card bg-(--card-bg) p-0 text-(--accent-amber) opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.14)] group-hover/env:pointer-events-auto group-hover/env:opacity-100"
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
            // A URL title has no spaces and only structural break points (/, -).
            // Under the chip's default `break-normal` it refuses to break at "/"
            // and overflows one clipped line, stranding a short tail (e.g.
            // "US.json") alone on line 2. overflow-wrap:break-word lets it wrap at
            // the "/" boundaries into balanced lines. Prose titles keep bionic +
            // the tuned break-normal path so short words never break awkwardly.
            return isUrlLikeTitle(seg)
              ? (
                <span key={`${keyPrefix}-url-${seg}`} className="chip-url-title wrap-break-word">
                  {highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`)}
                </span>
              )
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
                'chip-path font-normal text-tab-muted opacity-75',
                mode === 'chip'
                  ? 'inline-block whitespace-nowrap group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:whitespace-normal group-[.page-chip-expanded]/page-chip:wrap-break-word'
                  : 'inline-block max-w-[calc(100%-6px)] whitespace-normal break-normal w-max wrap-break-word'
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
    // Static marker consumed only by base.css: hovering the group's non-URL
    // surface highlights this pill via :hover CSS so it swaps with the exact
    // pill's own :hover inside one style recalc. Routing this highlight
    // through React state paints a one-frame rest-background flash instead.
    const variantIsDefaultTarget = defaultTitleVariantChip() === variant
    const variantDupeCount = variant.dupeCount || 1
    const variantIsHistorySource = variant.sourceType === 'history'
    const variantClosedSaved = variant.sourceType === 'saved-page' || !!variant.closedSaved
    const variantCanToggleSaved = (variant.sourceType === 'tab' || variant.sourceType === 'saved-page') && !variant.isApp
    const variantShowSavedHint = !!variant.saved && !variantCanToggleSaved
    const variantCanClose = !variantClosedSaved && (!isReadOnlyDashboardSourceType(variant.sourceType) || variantIsHistorySource)
    const variantActionCount = (variantShowSavedHint ? 1 : 0) + (variantCanClose ? 1 : 0)
    const variantSavedActionLabel = variant.saved ? 'Remove saved page' : 'Save page'
    const variantPagePinActionLabel = variant.pagePinned ? 'Unpin' : 'Pin'
    const variantCanTogglePagePin = !!variant.pagePinId && typeof onTogglePinnedPageChip === 'function'
    const variantTitleText = titleTextForChip(variant)
    const variantCanUseContextMenu = variantCanToggleSaved || variantCanTogglePagePin || !!variantTitleText || !!variant.tabUrl
    const variantPinnedLabel = variant.pagePinned ? 'Pinned' : ''
    const variantLabel = [variant.tooltip, variantPinnedLabel, variantDupeCount > 1 ? `${variantDupeCount} open copies` : '', variant.activeInOtherWindow ? 'Active in another window' : '', variant.saved ? (variantClosedSaved ? 'Closed saved page' : 'Saved page') : ''].filter(Boolean).join(' · ')
    // Variant rows carry no favicon, so the label text carries the liveness
    // signal the favicon would: dim when this variant has no awake tab.
    const variantDimmed = !!variant.suspended || variantClosedSaved
    const labelContent = (
      <>
        <span className={cn('chip-title-variant-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap', variantDimmed && VARIANT_LABEL_DIM_CLASS_NAME)}>
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
        data-tabout-layout-anchor={layoutScope ? '' : undefined}
        data-tabout-layout-key={layoutScope ? (variant.pagePinId || variant.rawUrl) : undefined}
        data-tabout-layout-scope={layoutScope || undefined}
        data-tabout-removal-anchor=""
        data-tabout-removal-key={`page:${variant.rawUrl}`}
        data-tabout-default-variant={variantIsDefaultTarget ? 'true' : undefined}
        className={cn(
          'chip-title-variant clickable flex w-full max-w-full min-w-0 cursor-default items-center gap-1 rounded-none border-0 bg-transparent px-1.5 py-[3px] [font-size:inherit] leading-tight font-normal text-neutral-600 hover:bg-neutral-600/[0.14] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
          '[&.page-chip-context-menu-open]:bg-neutral-600/[0.14] [&.page-chip-context-menu-open]:text-tab-ink',
          variantActive && 'bg-neutral-600/[0.075] text-tab-ink',
          variantCurrent && 'bg-neutral-100 text-tab-ink shadow-[inset_2px_0_0_0_var(--accent-amber)]',
          variantHoverMatched && 'bg-neutral-600/[0.14] text-tab-ink'
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
    const variantFocusTarget = variantCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={variantCanToggleSaved ? variantSavedActionLabel : undefined}
        saved={!!variant.saved}
        onSavedSelect={variantCanToggleSaved ? (e) => onToggleSavedTitleVariant(e, variant) : undefined}
        pagePinActionLabel={variantCanTogglePagePin ? variantPagePinActionLabel : undefined}
        pagePinned={!!variant.pagePinned}
        onPagePinSelect={variantCanTogglePagePin ? (e) => onTogglePinnedTitleVariant(e, variant) : undefined}
        titleText={variantTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, variantTitleText)}
        urlText={variant.tabUrl}
        onCopyUrl={(e) => onCopyUrlText(e, variant.tabUrl)}
        onOpenChange={(open) => onTitleVariantContextMenuOpenChange(open, variant)}
      >
        {variantFocusButton}
      </PageChipContextMenu>
    ) : (
      variantFocusButton
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={variant.rawUrl || variant.tabUrl}
          className="chip-title-variant inline-flex max-w-full items-center gap-1 rounded-lg bg-neutral-500/[0.045] px-1.5 py-0.5 leading-tight font-normal text-neutral-600 [corner-shape:squircle]"
        >
          {labelContent}
        </span>
      )
    }

    return (
      <span
        key={variant.rawUrl || variant.tabUrl}
        className="chip-title-variant-shell relative flex w-full max-w-full min-w-0 items-center"
      >
        {variantFocusTarget}
        {variantActionCount > 0 && (
          <span className={cn(
            'chip-title-variant-actions group/title-variant-actions absolute top-0 bottom-0 z-2 my-auto flex h-[19px] items-center gap-0.5',
            variantActionCount === 1 && '-left-[25.5px]',
            variantActionCount > 1 && '-left-[46.5px]'
          )}>
            {variantShowSavedHint && (
              <TooltipAnchor content="Saved page">
                <span
                  className="chip-title-variant-saved-hint pointer-events-none inline-flex size-[19px] cursor-default items-center justify-center rounded-full border-0 bg-transparent p-0 text-(--accent-amber) opacity-0 group-hover/title-variant-actions:pointer-events-auto group-hover/title-variant-actions:opacity-100"
                  aria-hidden="true"
                >
                  <SavedPageIcon saved className="size-3.5" />
                </span>
              </TooltipAnchor>
            )}
            {variantCanClose && (
              <button
                type="button"
                className="chip-title-variant-action pointer-events-none inline-flex size-[19px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted opacity-0 group-hover/title-variant-actions:pointer-events-auto group-hover/title-variant-actions:opacity-100 hover:bg-neutral-600/10 hover:text-tab-ink hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
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
      <span className="chip-title-variant-list flex w-full max-w-full flex-col items-stretch pr-[5px] pb-1 divide-y divide-neutral-500/15">
        {titleVariantChips.map((variant, index) => titleVariantNode(variant, index, mode))}
      </span>
    )
  }

  function expandedTitleContentNode(keyPrefix: string) {
    if (!chipExpanded || chipExpansionGeometry.lineHtml.length === 0) return null
    return expansionLineNodesFromHtml(
      chipExpansionLineMarkup(chipExpansionGeometry.lineHtml, chipExpansionGeometry.viewportConstrained),
      keyPrefix
    )
  }

  function titleRowContentNode(mode: ChipTextRenderMode, keyPrefix: string) {
    const expandedContent = expandedTitleContentNode(keyPrefix)
    if (expandedContent) return expandedContent
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

  function titleVariantTitleRowNode(mode: ChipTextRenderMode) {
    return (
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode(mode, `${mode}-expanded-title-variant-title`)}
      </span>
    )
  }

  function chipTextContentNode(mode: ChipTextRenderMode) {
    if (isFolded) {
      return (
        <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
          <span className="chip-title-row block min-w-0 max-w-full">
            {titleRowContentNode(mode, `${mode}-expanded-folded-title`)}
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

    if (mode === 'chip' && !chipExpanded && chipTextClamp && chipTextClamp.key === chipTextClampKey && chipTextClamp.lineHtml.length > 1) {
      return clampedTitleLineNodes(chipTextClamp.lineHtml, 'chip-text', rebuildClampedChipMarker)
    }

    return (
      titleRowContentNode(mode, `${mode}-expanded-title`)
    )
  }

  // Captured suppression pills come back as live nodes: the static rebuild
  // would drop their SVG glyph and freeze the context-driven hover tone. The
  // trailing-marker spacing class rides along from the captured element.
  function rebuildClampedChipMarker(element: Element, key: string) {
    if (!element.classList.contains('chip-title-suppression-marker')) return undefined
    const part = (element.getAttribute('aria-label') || '').replace(/^Suppressed title text:\s*/, '')
    if (!part) return undefined
    const markerSpacingClass = element.classList.contains('ml-1') ? 'ml-1' : element.classList.contains('ml-0.5') ? 'ml-0.5' : ''
    return suppressionMarkerNode(part, 'chip', key, markerSpacingClass)
  }

  const chipTooltipContent = chip.iconOnly ? (
    <span
      className={cn(
        "chip-text block min-w-0 max-w-[calc(100vw-32px)] hyphens-auto break-normal text-[13px] leading-tight text-(--ink) [font-family:inherit] [hyphenate-character:'']",
        "whitespace-normal wrap-break-word",
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]'
      )}
    >
      {chipTextContentNode('tooltip')}
    </span>
  ) : undefined

  const foldedTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-[5px] flex min-w-0 py-[5px]"
    >
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode('chip', 'chip-expanded-folded-title-trigger')}
      </span>
    </span>
  )

  const foldedChipTextContent = (
    <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        foldedTitleExpansionTriggerElement
      ) : (
        <span className="chip-title-row block min-w-0 max-w-full">
          {titleRowContentNode('chip', 'chip-expanded-folded-title-rest')}
        </span>
      )}
      <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
        {envs.map((env) => envLabelNode(env, 'chip'))}
      </span>
    </span>
  )

  const titleVariantTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-[5px] flex min-w-0 py-[5px]"
    >
      {titleVariantTitleRowNode('chip')}
    </span>
  )

  const titleVariantChipTextContent = (
    <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        titleVariantTitleExpansionTriggerElement
      ) : (
        titleVariantTitleRowNode('chip')
      )}
      {titleVariantListNode('chip')}
    </span>
  )

  const chipTextElement = (
    <span
      className={cn(
        "chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:''] [&.chip-text-truncated]:[mask-image:var(--title-fade-mask)]",
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]',
        chip.pathSuffix && 'max-h-[calc(3lh)]',
        isTitleVariantGroup && 'max-h-none !overflow-visible',
        isFolded && 'max-h-none',
        chipExpanded && '!max-h-none !max-w-none !flex-1 !overflow-visible ![mask-image:none] whitespace-normal wrap-break-word'
      )}
      ref={chipTextRef}
      onPointerEnter={onChipTextPointerEnter}
    >
      {isFolded ? foldedChipTextContent : isTitleVariantGroup ? titleVariantChipTextContent : chipTextContentNode('chip')}
    </span>
  )

  const chipTextExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-[5px] flex min-w-0 flex-1 py-[5px]"
    >
      {chipTextElement}
    </span>
  )

  const chipInteractionProps = parentInteractive
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: onFocus,
        onMouseDown: onChipPointerDown,
        onKeyDown: onChipKeyDown,
        onMouseEnter: onChipMouseEnter,
        onMouseLeave: onChipMouseLeave,
        onFocus: onChipFocus,
        onBlur: onChipBlur
      } as const
    : {}

  // The grouped chip stays keyboard-inert (no role/tabIndex — the URL variant
  // buttons are the keyboard targets), but its whole mouse surface targets the
  // default variant. These live on the rectangular `.chip-slot`, NOT the
  // `.page-chip`: the chip is rounded (`rounded-[10px] [corner-shape:squircle]`)
  // so clicks at its corners fall through to the slot underneath; owning them
  // on the slot makes the corner gutter activate the default variant too (the
  // base.css hover highlight is keyed off the slot for the same reason). The
  // exact pills, their action rails, the favicon close, and the audio toggle
  // each stop propagation, so only title/blank-surface clicks reach here.
  const variantGroupInteractionProps = isTitleVariantGroup
    ? {
        onClick: onVariantGroupChipClick,
        onMouseDown: onVariantGroupChipMouseDown,
        onMouseEnter: onVariantGroupChipMouseEnter,
        onMouseMove: onVariantGroupChipMouseMove,
        onMouseLeave: onVariantGroupChipMouseLeave
      } as const
    : {}

  const chipElement = (
      <div
        data-tabout="page-chip"
        data-expanded={chipExpanded ? 'true' : undefined}
        className={cn(
          "page-chip group/page-chip relative flex items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight text-(--ink) [font-family:inherit] [corner-shape:squircle] transition-[color,box-shadow] duration-100 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-(--group-color,transparent) before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-(--chip-hover-fade-width) after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_34%,var(--chip-hover-fade-bg)_100%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:[transform:scale(0.96)] motion-reduce:[&.closing]:transform-none",
          !chip.iconOnly && 'w-full',
          parentInteractive && 'clickable cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-amber)',
          chipVisualOpen && CHIP_TRIM_TOKENS.tooltipOpen,
          chipExpanded && 'page-chip-expanded absolute z-30 min-w-0 max-w-(--page-chip-expanded-max-width) !overflow-visible !transition-none w-(--page-chip-expanded-width) shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
          chipExpanded && 'left-0',
          chipExpanded && (chipExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
          trim.chipClasses,
          isTitleVariantGroup && 'cursor-default',
          isFolded && `${CHIP_TRIM_TOKENS.folded} cursor-default after:hidden`,
          chip.saved && 'page-chip-saved',
          hoverMatched && `${CHIP_TRIM_TOKENS.hoverMatch} outline outline-1 outline-offset-1 outline-(--accent-amber)`,
          suppressionHighlighted && cn('page-chip-suppression-highlighted', titleSuppressionChipHighlightClass(activeSuppressionTone)),
          chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 rounded-xl bg-transparent p-0 [corner-shape:squircle] before:hidden after:hidden',
          trim.iconChipClasses
        )}
        aria-label={chipLabel}
        style={chipStyle}
        onPointerEnter={onChipPointerEnter}
        onPointerMove={onChipPointerMove}
        onPointerLeave={onChipPointerLeave}
        {...chipInteractionProps}
      >
      {trim.expandedFill && (
        <span
          aria-hidden="true"
          className={trim.expandedFill.classes}
          style={{
            top: trim.expandedFill.top,
            bottom: trim.expandedFill.bottom,
            backgroundColor: trim.expandedFill.background
          }}
        />
      )}
      {trim.frame && (
        <span className={trim.frame.classes} aria-hidden="true" />
      )}
      {showFaviconFrame && (
        <ChipFaviconFrame
          chip={chip}
          dupeCount={dupeCount}
          showDefaultFavicon={showDefaultFavicon}
          showFaviconCloseAction={showFaviconCloseAction}
          dedupeBadgesClosing={dedupeBadgesClosing}
          closeActionLabel={closeActionLabel}
          onCloseAction={isTitleVariantGroup ? onCloseAllVariants : isHistorySource ? onDeleteHistory : onClose}
          onToggleAudio={onToggleChipAudio}
        />
      )}
      {!chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleChipAudio}
          className="mt-[1px] self-start"
        />
      )}
      {!chip.iconOnly && chip.chromePinned && (
        <span
          data-tabout-part="chrome-pin"
          className="chip-chrome-pin icon-[lucide--pin] mt-[1px] size-3 shrink-0 text-tab-muted opacity-70"
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && (
        isFolded || isTitleVariantGroup ? chipTextElement : shouldExpandChip ? chipTextExpansionTriggerElement : chipTextElement
      )}
      {!chip.iconOnly && showSavedHint && (
        <div className="chip-actions absolute top-1/2 right-2 z-2 flex -translate-y-1/2 items-center gap-0.5">
          <TooltipAnchor content="Saved page">
            <span
              className="chip-action chip-saved-hint pointer-events-none inline-flex shrink-0 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-1 text-(--accent-amber) opacity-0 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 group-[.page-chip-context-menu-open]/page-chip:pointer-events-auto group-[.page-chip-context-menu-open]/page-chip:opacity-100 group-[.page-chip-tooltip-open]/page-chip:pointer-events-auto group-[.page-chip-tooltip-open]/page-chip:opacity-100"
              aria-hidden="true"
            >
              <SavedPageIcon saved className="size-[14px]" />
            </span>
          </TooltipAnchor>
        </div>
      )}
      </div>
  )
  const chipElementWithContextMenu = !chip.iconOnly && (canToggleSavedPage || canTogglePagePin || canShowSuspend || canUseCopyContextMenu) ? (
    <PageChipContextMenu
      savedActionLabel={canToggleSavedPage ? savedActionLabel : undefined}
      saved={!!chip.saved}
      onSavedSelect={canToggleSavedPage ? onToggleSavedPage : undefined}
      pagePinActionLabel={canTogglePagePin ? pagePinActionLabel : undefined}
      pagePinned={!!chip.pagePinned}
      onPagePinSelect={canTogglePagePin ? onTogglePagePin : undefined}
      suspendEnabled={suspendEnabled}
      onSuspendSelect={canShowSuspend ? onToggleChipSuspend : undefined}
      titleText={chipTitleText}
      onCopyTitle={(e) => onCopyTitleText(e, chipTitleText)}
      urlText={chipUrlText}
      onCopyUrl={(e) => onCopyUrlText(e, chipUrlText)}
      onOpenChange={onChipContextMenuOpenChange}
    >
      {chipElement}
    </PageChipContextMenu>
  ) : chipElement

  const renderedChipElement = chip.iconOnly && chipTooltipContent ? (
    <TooltipAnchor
      content={chipTooltipContent}
      className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight wrap-break-word cursor-default select-none"
      instant
      onClick={onPageChipTooltipClick}
      onOpenChange={onChipTooltipOpenChange}
      style={chipTooltipStyle}
    >
      {chipElement}
    </TooltipAnchor>
  ) : chipElementWithContextMenu

  return (
    <div
      data-tabout-part="slot"
      data-tabout-layout-anchor={layoutScope ? '' : undefined}
      data-tabout-layout-item={layoutScope ? '' : undefined}
      data-tabout-layout-key={layoutScope ? chipLayoutKey : undefined}
      data-tabout-layout-scope={layoutScope || undefined}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`page:${chip.rawUrl}`}
      // The hover-match slot lift (z-3) stays below the interacting-slot
      // lift (z-4, inside trim.slotClasses) by specificity, so a deliberate
      // interaction always wins over passive hover-match at the seam.
      className={cn('chip-slot relative min-w-0', chip.iconOnly ? 'inline-flex' : `${trim.slotClasses} flex w-full`, hoverMatched && 'z-3')}
      style={chipSlotStyle}
      ref={chipSlotRef}
      {...variantGroupInteractionProps}
    >
      {renderedChipElement}
    </div>
  )
}

export function PageChip(props: PageChipProps) {
  return usePageChipElement(props)
}
