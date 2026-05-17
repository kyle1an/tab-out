import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, FocusEvent, KeyboardEvent, MouseEvent, ReactNode, SetStateAction } from 'react'
import { isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import { matchValuesForFilterTerm, parseFilterQuery } from '../extension/filter-query.js'
import { focusExactTab, focusTab, openTabUrl } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls } from '../extension/tab-actions'
import { useDomainCardContext } from './DomainCardContext'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { TITLE_SUPPRESSION_MARKER_SYMBOL, titleSuppressionChipHighlightClass, titleSuppressionMarkerClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData, LayoutChangeHandler } from './types'
import type { DashboardChipEnv, DashboardSegment } from '../extension/types'

let chipTextResizeObserver: ResizeObserver | null = null
const chipTextTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: { isTruncated: boolean; width: number }) => void
>()
export const PAGE_CHIP_CLOSE_ANIMATION_MS = 200
const PAGE_CHIP_CLOSE_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

interface PageChipProps {
  chip: DashboardChipData
  filter?: string
  suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
}

type ChipTextRenderMode = 'chip' | 'tooltip'
type HighlightMode = 'parsed' | 'legacy'
type PageChipCloseAnimationStyle = Partial<Pick<CSSStyleDeclaration, 'height' | 'left' | 'margin' | 'maxHeight' | 'opacity' | 'overflow' | 'paddingBottom' | 'paddingTop' | 'pointerEvents' | 'position' | 'top' | 'transform' | 'transformOrigin' | 'transition' | 'width' | 'zIndex'>>
type PageChipCloseAnimationGhost = {
  classList: Pick<DOMTokenList, 'add'>
  style: PageChipCloseAnimationStyle
  getBoundingClientRect?: () => unknown
  setAttribute?: (name: string, value: string) => void
  remove?: () => void
}
type PageChipCloseAnimationElement = {
  classList: Pick<DOMTokenList, 'add'> & Partial<Pick<DOMTokenList, 'remove'>>
  style: PageChipCloseAnimationStyle
  getBoundingClientRect: () => Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>
  cloneNode?: (deep?: boolean) => PageChipCloseAnimationGhost
  ownerDocument?: {
    body?: {
      appendChild: (node: PageChipCloseAnimationGhost) => unknown
    }
  }
}
type PageChipCloseAnimationScheduler = (handler: () => void, delay: number) => unknown

function isPageChipCloseAnimationElement(value: unknown): value is PageChipCloseAnimationElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PageChipCloseAnimationElement>
  return (
    !!candidate.classList &&
    typeof candidate.classList.add === 'function' &&
    !!candidate.style &&
    typeof candidate.getBoundingClientRect === 'function'
  )
}

function shouldReduceCloseMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function pageChipCloseAnimationWaitMs() {
  return shouldReduceCloseMotion() ? 0 : PAGE_CHIP_CLOSE_ANIMATION_MS
}

function schedulePageChipCloseAnimationCleanup(handler: () => void, delay: number) {
  return window.setTimeout(handler, delay)
}

function createClosingGhost(chipEl: PageChipCloseAnimationElement, rect: Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>, duration: number, scheduleCleanup: PageChipCloseAnimationScheduler) {
  const ghost = chipEl.cloneNode?.(true)
  const body = chipEl.ownerDocument?.body
  if (!ghost || !body) return

  ghost.classList.add('page-chip-closing-ghost')
  ghost.setAttribute?.('aria-hidden', 'true')
  ghost.style.position = 'fixed'
  ghost.style.left = `${rect.left}px`
  ghost.style.top = `${rect.top}px`
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
  ghost.style.margin = '0'
  ghost.style.maxHeight = `${rect.height}px`
  ghost.style.overflow = 'hidden'
  ghost.style.pointerEvents = 'none'
  ghost.style.zIndex = '50'
  ghost.style.opacity = '1'
  ghost.style.transform = 'scale(1)'
  ghost.style.transformOrigin = 'top left'
  ghost.style.transition = duration > 0
    ? [
        `opacity ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`,
        `transform ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`
      ].join(', ')
    : 'none'

  body.appendChild(ghost)
  ghost.getBoundingClientRect?.()
  ghost.style.opacity = '0'
  ghost.style.transform = 'scale(0.96)'
  scheduleCleanup(() => ghost.remove?.(), duration + 80)
}

export function startPageChipCloseAnimation(chipEl: unknown, onLayoutChange: LayoutChangeHandler | null = null, scheduleCleanup: PageChipCloseAnimationScheduler = schedulePageChipCloseAnimationCleanup): boolean {
  if (!isPageChipCloseAnimationElement(chipEl)) return false

  const duration = shouldReduceCloseMotion() ? 0 : PAGE_CHIP_CLOSE_ANIMATION_MS
  const rect = chipEl.getBoundingClientRect()
  const height = Math.max(0, Math.ceil(rect.height))
  createClosingGhost(chipEl, rect, duration, scheduleCleanup)
  chipEl.style.maxHeight = `${height}px`
  chipEl.style.overflow = 'hidden'
  chipEl.style.opacity = '0'
  chipEl.style.transition = duration > 0
    ? [
        `max-height ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`,
        `padding ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`
      ].join(', ')
    : 'none'

  chipEl.getBoundingClientRect()
  chipEl.classList.add('closing')
  chipEl.style.maxHeight = '0px'
  chipEl.style.paddingTop = '0px'
  chipEl.style.paddingBottom = '0px'
  onLayoutChange?.({ animate: duration > 0 })
  return true
}

async function waitForPageChipCloseAnimation() {
  const duration = pageChipCloseAnimationWaitMs()
  if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration))
}

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
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

function renderHighlightedText(text: string, highlightTerms: readonly string[], keyPrefix: string): ReactNode {
  if (!text || highlightTerms.length === 0) return text

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

  if (ranges.length === 0) return text

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
    if (originalStart > cursor) nodes.push(text.slice(cursor, originalStart))
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

  if (cursor < text.length) nodes.push(text.slice(cursor))
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

function syncChipTextFade(textEl: HTMLElement | null) {
  if (!textEl) return { isTruncated: false, width: 0 }

  const isTruncated = isChipTextTruncated(textEl)
  const width = getChipTextWidth(textEl)
  textEl.classList.toggle('chip-text-truncated', isTruncated)
  chipTextTruncationCallbacks.get(textEl)?.({ isTruncated, width })
  return { isTruncated, width }
}

function updateChipTextTruncation(
  textEl: HTMLElement | null,
  setIsTextTruncated: Dispatch<SetStateAction<boolean>>,
  setChipTextWidth: Dispatch<SetStateAction<number>>
) {
  const { isTruncated, width } = syncChipTextFade(textEl)
  setIsTextTruncated((current) => current === isTruncated ? current : isTruncated)
  setChipTextWidth((current) => Math.abs(current - width) < 0.1 ? current : width)
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

export function PageChip({ chip, filter = '', suppressedTitleToneByText }: PageChipProps) {
  const { activeSuppressedTitle, dedupeBadgesClosing, onHoverUrlChange, activeHoverUrl, activeHoverUrls, activeHoverSource, onLayoutChange } = useDomainCardContext()
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const hasFilter = filter.trim().length > 0
  const isHistorySource = chip.sourceType === 'history'
  const highlightTerms = highlightTermsForFilter(filter, isHistorySource ? 'legacy' : 'parsed')
  const isReadOnlySource = isReadOnlyDashboardSourceType(chip.sourceType)
  const primaryPreviewUrl = chip.tabUrl || ''
  const suppressedTitleParts = chip.suppressedTitleParts || []
  const activeSuppressedTitleKey = activeSuppressedTitle.trim().toLowerCase()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const suppressionHighlighted = activeSuppressedTitleKey !== '' && suppressedTitleParts.some((part) => part.toLowerCase() === activeSuppressedTitleKey)
  const chipTextRef = useRef<HTMLSpanElement | null>(null)
  const [isTextTruncated, setIsTextTruncated] = useState(false)
  const [chipTextWidth, setChipTextWidth] = useState(0)

  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    const frameId = requestAnimationFrame(() => updateChipTextTruncation(textEl, setIsTextTruncated, setChipTextWidth))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    let disposed = false
    const observer = getChipTextResizeObserver()
    chipTextTruncationCallbacks.set(textEl, ({ isTruncated, width }) => {
      if (disposed) return
      setIsTextTruncated((current) => current === isTruncated ? current : isTruncated)
      setChipTextWidth((current) => Math.abs(current - width) < 0.1 ? current : width)
    })
    observer?.observe(textEl)

    const fontSet = document.fonts
    const onFontsDone = () => {
      if (!disposed) updateChipTextTruncation(textEl, setIsTextTruncated, setChipTextWidth)
    }
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(onFontsDone)

    return () => {
      disposed = true
      observer?.unobserve(textEl)
      chipTextTruncationCallbacks.delete(textEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
    }
  }, [])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function focusChipUrl(targetUrl: string | undefined) {
    if (!targetUrl) return
    if (isReadOnlySource) {
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

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus()
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    await focusChipUrl(env.tabUrl)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    await focusChipUrl(env.tabUrl)
  }

  function setPreview(url: string, matchUrls: readonly string[] = [url]) {
    if (onHoverUrlChange) onHoverUrlChange(url || '', 'chip', matchUrls)
  }

  function onChipMouseEnter() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, [chip.tabUrl, chip.rawUrl])
  }

  function onChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onChipFocus() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, [chip.tabUrl, chip.rawUrl])
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onEnvMouseEnter(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl])
  }

  function onEnvMouseLeave(e: MouseEvent<HTMLButtonElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    setPreview('')
  }

  function onEnvFocus(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl])
  }

  function onEnvBlur(e: FocusEvent<HTMLButtonElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
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
    const urls: string[] = Array.from(new Set(isFolded ? envs.map((env) => env.tabUrl).filter(Boolean) : [chip.tabUrl].filter(Boolean)))
    if (urls.length === 0) return

    await deleteHistoryUrls({
      urls,
      onAfterDelete: async () => {
        if (startPageChipCloseAnimation(chipEl, onLayoutChange)) await waitForPageChipCloseAnimation()
        setPreview('')
      }
    })
  }

  const hasActiveChipFrame = !!(chip.activeChipFrame || chip.activeInOtherWindow)
  const isCurrentActiveFrame = !!chip.activeChipFrame && !chip.activeInOtherWindow
  const style = {
    '--chip-hover-fade-bg': hasActiveChipFrame
      ? 'color-mix(in srgb, var(--card-bg) 82%, rgb(82 82 82))'
      : 'color-mix(in srgb, var(--card-bg) 87%, rgb(82 82 82))',
    ...(chip.isGrouped ? { '--group-color': chip.groupDotColor } : {})
  } as CSSProperties
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const hiddenTitleLabel = suppressedTitleParts.length > 0 ? `Suppressed title text: ${suppressedTitleParts.join(' · ')}` : ''
  const chipLabel = [chip.tooltip, hiddenTitleLabel, duplicateLabel, activeLabel].filter(Boolean).join(' · ')
  const closeActionLabel = isHistorySource ? 'Delete from history' : 'Close this tab'
  const hasTitleSuppressionMarkers = suppressedTitleParts.length > 0 || chip.displaySegments.some(isTitleSuppressionSegment)
  const hasStructuralPlaceholders = chip.displaySegments.some((segment) => isStructuralPlaceholderSegment(segment) && !!(segment.label || chip.pathGroupLabel))
  const shouldShowChipTooltip = chip.iconOnly || isTextTruncated || hasTitleSuppressionMarkers || hasStructuralPlaceholders
  const chipTooltipTextWidth = !chip.iconOnly && chipTextWidth > 0 ? `${chipTextWidth}px` : ''
  const chipTooltipStyle = chipTooltipTextWidth ? {
    '--page-chip-tooltip-text-width': chipTooltipTextWidth
  } as CSSProperties : undefined
  const hoverMatched = !!activeHoverSource && activeHoverSource !== 'chip' && !!activeHoverUrl && (
    chip.tabUrl === activeHoverUrl ||
    chip.rawUrl === activeHoverUrl ||
    activeHoverUrls.includes(chip.tabUrl) ||
    activeHoverUrls.includes(chip.rawUrl) ||
    envs.some((env) => (
      env.tabUrl === activeHoverUrl ||
      env.rawUrl === activeHoverUrl ||
      activeHoverUrls.includes(env.tabUrl) ||
      activeHoverUrls.includes(env.rawUrl)
    ))
  )

  function renderSuppressionMarker(part: string, mode: ChipTextRenderMode, key: string, markerClassName = '') {
    const partKey = part.trim().toLowerCase()
    const active = activeSuppressedTitleKey !== '' && partKey === activeSuppressedTitleKey
    const tone = active ? activeSuppressionTone : suppressedTitleToneByText?.get(partKey) ?? ''
    const label = `Suppressed title text: ${part}`
    const marker = (
      <span
        key={key}
        className={cn(
          'chip-title-suppression-marker inline-flex h-4 min-w-4 items-center justify-center rounded-lg border border-transparent bg-[rgba(115,115,115,0.08)] px-1 text-xs leading-none font-medium text-tab-muted align-baseline [corner-shape:squircle]',
          markerClassName,
          titleSuppressionMarkerClass(tone, active)
        )}
        aria-label={label}
      >
        {TITLE_SUPPRESSION_MARKER_SYMBOL}
      </span>
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={key}
          className={cn(
            'chip-title-suppression-marker inline-flex min-h-4 max-w-full items-center justify-center rounded-lg border border-transparent bg-[rgba(115,115,115,0.08)] px-1 text-xs leading-4 font-medium text-tab-muted align-baseline [corner-shape:squircle] [overflow-wrap:anywhere]',
            markerClassName,
            titleSuppressionMarkerClass(tone, active)
          )}
          aria-label={label}
        >
          {renderHighlightedText(part, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function renderTrailingSuppressionMarkers(mode: ChipTextRenderMode) {
    if (suppressedTitleParts.length === 0) return null

    const inlineSuppressedTitleKeys = new Set(
      chip.displaySegments
        .filter(isTitleSuppressionSegment)
        .map((segment) => segment.titleSuppression.trim().toLowerCase())
    )
    const trailingParts = suppressedTitleParts.filter((part) => !inlineSuppressedTitleKeys.has(part.trim().toLowerCase()))

    return trailingParts.map((part, index) => {
      const markerSpacingClass = mode === 'chip' ? (index === 0 ? 'ml-1' : 'ml-0.5') : ''
      const marker = renderSuppressionMarker(
        part,
        mode,
        `trailing-title-suppression-marker-${part}`,
        markerSpacingClass
      )

      if (mode === 'tooltip') {
        return (
          <span key={`trailing-title-suppression-${part}-${index}`}>
            {' '}
            {marker}
          </span>
        )
      }

      return marker
    })
  }

  function renderStructuralPlaceholder(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string) {
    const hiddenLabel = segment.label || chip.pathGroupLabel
    const marker = (
      <span
        key={key}
        className="chip-strip-indicator inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]"
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
          className="chip-strip-indicator inline-block max-w-full rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle] [overflow-wrap:anywhere]"
          aria-label={hiddenLabel}
        >
          {renderHighlightedText(hiddenLabel, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function renderEnvLabel(env: DashboardChipEnv, mode: ChipTextRenderMode) {
    const envLabel = `Focus ${env.prefix} tab${env.activeInOtherWindow ? ' (active in another window)' : ''}`
    const envClassName = cn(
      "chip-env inline-flex items-center rounded-lg border-0 bg-[rgba(115,115,115,0.05)] px-1.5 text-xs leading-[inherit] font-medium text-tab-muted [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.']",
      isFolded && 'h-6 rounded-[7px] px-2',
      mode === 'chip' && 'clickable cursor-pointer transition-[background,color,box-shadow] duration-150 ease-in-out hover:bg-[rgba(10,10,10,0.12)] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]',
      env.activeInOtherWindow && 'bg-[rgba(82,82,82,0.13)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]'
    )

    if (mode === 'tooltip') {
      return (
        <span key={env.rawUrl || env.tabUrl} className={envClassName}>
          {renderHighlightedText(env.prefix, highlightTerms, `tooltip-env-${env.prefix}`)}
        </span>
      )
    }

    return (
      <TooltipAnchor key={env.rawUrl || env.tabUrl} content={envLabel}>
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
          {renderHighlightedText(env.prefix, highlightTerms, `env-${env.prefix}`)}
        </button>
      </TooltipAnchor>
    )
  }

  function renderTitleContent(mode: ChipTextRenderMode) {
    return (
      <>
        {chip.pathGroupLabel && (
          <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]">
            {renderHighlightedText(pathGroupDisplayLabel(chip.pathGroupLabel), highlightTerms, `${mode}-pathgroup`)}
          </span>
        )}
        {chip.displaySegments.map((seg, index) => {
          if (typeof seg === 'string') return renderHighlightedText(seg, highlightTerms, `${mode}-segment-${index}`)
          if (isTitleSuppressionSegment(seg)) return renderSuppressionMarker(seg.titleSuppression, mode, `inline-title-suppression-${index}`)
          if (isStructuralPlaceholderSegment(seg)) return renderStructuralPlaceholder(seg, mode, `structural-placeholder-${index}`)
          return null
        })}
        {renderTrailingSuppressionMarkers(mode)}
        {chip.pathSuffix && (
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
              {renderHighlightedText(chip.pathSuffix, highlightTerms, `${mode}-path`)}
            </span>
          </>
        )}
      </>
    )
  }

  function renderChipTextContent(mode: ChipTextRenderMode) {
    if (isFolded) {
      return (
        <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
          <span className="chip-title-row block min-w-0 max-w-full">
            {renderTitleContent(mode)}
          </span>
          <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
            {envs.map((env) => renderEnvLabel(env, mode))}
          </span>
        </span>
      )
    }

    return (
      <>
        {chip.leadPrefix && (
          <span className="chip-subdomain mr-1.5 font-medium text-tab-muted after:ml-1.5 after:opacity-50 after:content-['·']">
            {renderHighlightedText(chip.leadPrefix, highlightTerms, `${mode}-lead`)}
          </span>
        )}
        {renderTitleContent(mode)}
      </>
    )
  }

  const chipTooltipContent = shouldShowChipTooltip ? (
    <span
      className={cn(
        "chip-text block min-w-0 max-w-[calc(100vw-32px)] whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [hyphenate-character:''] [overflow-wrap:break-word]",
        chipTooltipTextWidth && 'w-[var(--page-chip-tooltip-text-width)]',
        hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]'
      )}
    >
      {renderChipTextContent('tooltip')}
    </span>
  ) : undefined

  return (
    <TooltipAnchor
      content={chipTooltipContent}
      className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight [overflow-wrap:break-word]"
      style={chipTooltipStyle}
    >
      <div
        className={cn(
          "page-chip group/page-chip relative flex items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [corner-shape:squircle] transition-[color,box-shadow] duration-100 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:[transform:scale(0.96)] motion-reduce:[&.closing]:transform-none",
          !isFolded && 'clickable cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)]',
          !isFolded && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.13)] [&:has(.chip-actions):hover::after]:opacity-100',
          hasActiveChipFrame && !isCurrentActiveFrame && 'bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)]',
          isCurrentActiveFrame && 'current-active-chip bg-neutral-100 text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400',
          hasActiveChipFrame && !isFolded && !isCurrentActiveFrame && 'hover:bg-[rgba(82,82,82,0.18)]',
          isFolded && 'page-chip-folded cursor-default after:hidden',
          hoverMatched && 'page-chip-hover-match',
          suppressionHighlighted && cn('page-chip-suppression-highlighted', titleSuppressionChipHighlightClass(activeSuppressionTone)),
          chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 overflow-hidden rounded-xl border-0 bg-transparent p-0 [corner-shape:squircle] [outline:1px_solid_rgba(115,115,115,0.18)] outline-offset-[1px] before:hidden after:hidden',
          chip.iconOnly && chip.isApp && 'overflow-visible outline-none',
          chip.iconOnly && hasActiveChipFrame && 'bg-[rgba(82,82,82,0.075)] [outline:1px_solid_rgba(82,82,82,0.32)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]'
        )}
        aria-label={chipLabel}
        style={style}
        tabIndex={isFolded ? undefined : 0}
        onClick={isFolded ? undefined : onFocus}
        onKeyDown={isFolded ? undefined : onChipKeyDown}
        onMouseEnter={isFolded ? undefined : onChipMouseEnter}
        onMouseLeave={isFolded ? undefined : onChipMouseLeave}
        onFocus={isFolded ? undefined : onChipFocus}
        onBlur={isFolded ? undefined : onChipBlur}
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
      {chip.faviconUrl && (
        <span
          className={cn(
            'chip-favicon-frame relative grid h-4 w-4 shrink-0 place-items-center',
            chip.isApp && 'is-app box-border h-6 w-6 rounded-xl border border-[rgba(115,115,115,0.32)] p-1 [corner-shape:squircle]'
          )}
        >
          <img className="chip-favicon block h-full w-full rounded-none object-cover" src={chip.faviconUrl} alt="" />
          {!chip.iconOnly && dupeCount > 1 && (
            <span
              className={cn(
                'chip-dupe-badge pointer-events-none absolute -top-[7px] -right-[7px] z-1 box-border inline-flex h-4 w-4 min-w-4 items-start justify-center rounded-full border-2 border-tab-card bg-[var(--accent-amber)] px-0 pt-px text-[9px] leading-none font-bold tabular-nums text-tab-card shadow-[0_1px_2px_rgba(10,10,10,0.18)] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-[ease]',
                dupeCount > 9 && 'chip-dupe-badge-wide w-auto rounded-lg px-1 [corner-shape:squircle]',
                dedupeBadgesClosing && 'closing'
              )}
              aria-hidden="true"
            >
              {dupeCount}
            </span>
          )}
        </span>
      )}
      {!chip.iconOnly && (
        <span
          className={cn(
            "chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:''] [&.chip-text-truncated]:[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_1lh),transparent_calc(100%_-_1lh)),linear-gradient(to_right,black_0,black_calc(100%_-_60px),rgba(0,0,0,0.35)_calc(100%_-_20px),transparent)]",
            hasFilter && 'text-[color-mix(in_srgb,var(--ink)_72%,var(--muted))]',
            chip.pathSuffix && 'max-h-[calc(3lh)]',
            isFolded && 'max-h-none'
          )}
          ref={chipTextRef}
        >
          {renderChipTextContent('chip')}
        </span>
      )}
      {!chip.iconOnly && !isFolded && (!isReadOnlySource || isHistorySource) && (
        <div className="chip-actions absolute top-1/2 right-2 z-[2] flex -translate-y-1/2 items-center gap-0.5">
          <TooltipAnchor content={closeActionLabel}>
            <button
              type="button"
              className="chip-action chip-close pointer-events-none inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-1 text-tab-muted opacity-0 transition-[opacity,color,background] duration-150 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:opacity-100"
              aria-label={closeActionLabel}
              onClick={isHistorySource ? onDeleteHistory : onClose}
            >
              <svg className="h-[15px] w-[15px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </TooltipAnchor>
        </div>
      )}
      </div>
    </TooltipAnchor>
  )
}
