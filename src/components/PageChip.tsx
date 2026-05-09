import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { focusExactTab, focusTab, openTabUrl } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls } from '../extension/tab-actions'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { DashboardChipData, HoverUrlChangeHandler } from './types'
import type { DashboardChipEnv } from '../extension/types'

let chipTextResizeObserver: ResizeObserver | null = null

interface PageChipProps {
  chip: DashboardChipData
  filter?: string
  onHoverUrlChange?: HoverUrlChangeHandler | null
}

function renderHighlightedText(text: string, filter: string, keyPrefix: string): ReactNode {
  const query = filter.trim()
  if (!text || !query) return text

  const normalizedChars: string[] = []
  const originalIndexes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\u200B') continue
    normalizedChars.push(char)
    originalIndexes.push(index)
  }

  const normalizedText = normalizedChars.join('').toLowerCase()
  const normalizedQuery = query.toLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  let searchFrom = 0

  while (searchFrom < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchFrom)
    if (matchIndex === -1) break

    const originalStart = originalIndexes[matchIndex]
    const normalizedEnd = matchIndex + normalizedQuery.length
    const originalEnd = normalizedEnd < originalIndexes.length ? originalIndexes[normalizedEnd] : text.length
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
    searchFrom = normalizedEnd
  }

  if (nodes.length === 0) return text
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

function syncChipTextFade(textEl: HTMLElement | null) {
  if (!textEl) return
  textEl.classList.toggle('chip-text-truncated', isChipTextTruncated(textEl))
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

export function PageChip({ chip, filter = '', onHoverUrlChange = null }: PageChipProps) {
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const hasFilter = filter.trim().length > 0
  const isHistorySource = chip.sourceType === 'history'
  const isReadOnlySource = chip.sourceType === 'bookmark' || isHistorySource
  const primaryPreviewUrl = isFolded ? envs[0]?.tabUrl || '' : chip.tabUrl || ''
  const chipTextRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    const frameId = requestAnimationFrame(() => syncChipTextFade(textEl))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    const observer = getChipTextResizeObserver()
    observer?.observe(textEl)

    const fontSet = document.fonts
    const onFontsDone = () => syncChipTextFade(textEl)
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(() => syncChipTextFade(textEl))

    return () => {
      observer?.unobserve(textEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
    }
  }, [])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function onFocus() {
    const targetUrl = isFolded ? envs[0]?.tabUrl : chip.tabUrl
    if (!targetUrl) return
    if (isReadOnlySource) {
      const focused = await focusExactTab(targetUrl)
      if (!focused) await openTabUrl(targetUrl)
      return
    }
    await focusTab(targetUrl)
  }

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus()
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    if (!env.tabUrl) return
    if (isReadOnlySource) {
      const focused = await focusExactTab(env.tabUrl)
      if (!focused) await openTabUrl(env.tabUrl)
      return
    }
    await focusTab(env.tabUrl)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (!env.tabUrl) return
    if (isReadOnlySource) {
      const focused = await focusExactTab(env.tabUrl)
      if (!focused) await openTabUrl(env.tabUrl)
      return
    }
    await focusTab(env.tabUrl)
  }

  function setPreview(url: string) {
    if (onHoverUrlChange) onHoverUrlChange(url || '')
  }

  function onChipMouseEnter() {
    setPreview(primaryPreviewUrl)
  }

  function onChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onChipFocus() {
    setPreview(primaryPreviewUrl)
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onEnvMouseEnter(env: DashboardChipEnv) {
    setPreview(env.tabUrl)
  }

  function onEnvMouseLeave(e: MouseEvent<HTMLButtonElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    setPreview('')
  }

  function onEnvFocus(env: DashboardChipEnv) {
    setPreview(env.tabUrl)
  }

  function onEnvBlur(e: FocusEvent<HTMLButtonElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
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
          chipEl.classList.add('closing')
          await new Promise((resolve) => setTimeout(resolve, 200))
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
        chipEl?.classList.add('closing')
        await new Promise((resolve) => setTimeout(resolve, 200))
        setPreview('')
      }
    })
  }

  const style = {
    '--chip-hover-fade-bg': chip.activeInOtherWindow
      ? 'color-mix(in srgb, var(--card-bg) 90.5%, rgb(82 82 82))'
      : 'color-mix(in srgb, var(--card-bg) 96%, rgb(82 82 82))',
    ...(chip.isGrouped ? { '--group-color': chip.groupDotColor } : {})
  } as CSSProperties
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const chipLabel = [chip.tooltip, duplicateLabel, activeLabel].filter(Boolean).join(' · ')
  const closeActionLabel = isHistorySource ? 'Delete from history' : 'Close this tab'

  return (
    <TooltipAnchor content={chipLabel}>
      <div
        className={cn(
          "page-chip clickable group/page-chip relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [corner-shape:squircle] transition-colors duration-150 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_50%)] after:opacity-0 after:transition-opacity after:duration-200 after:ease-[ease] after:[corner-shape:squircle] after:content-[''] hover:bg-[rgba(82,82,82,0.04)] [&:has(.chip-actions):hover::after]:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-200 [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.8)]",
          chip.activeInOtherWindow && 'bg-[rgba(82,82,82,0.075)] text-tab-ink shadow-[0_1px_2px_rgba(10,10,10,0.04)] hover:bg-[rgba(82,82,82,0.095)]',
          isFolded && 'page-chip-folded after:hidden',
          chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 overflow-hidden rounded-xl border-0 bg-transparent p-0 [corner-shape:squircle] [outline:1px_solid_rgba(115,115,115,0.18)] outline-offset-[1px] before:hidden after:hidden',
          chip.iconOnly && chip.isApp && 'overflow-visible outline-none',
          chip.iconOnly && chip.activeInOtherWindow && 'bg-[rgba(82,82,82,0.075)] [outline:1px_solid_rgba(82,82,82,0.32)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]'
        )}
        aria-label={chipLabel}
        style={style}
        tabIndex={0}
        onClick={onFocus}
        onKeyDown={onChipKeyDown}
        onMouseEnter={onChipMouseEnter}
        onMouseLeave={onChipMouseLeave}
        onFocus={onChipFocus}
        onBlur={onChipBlur}
      >
      {chip.activeInOtherWindow && !chip.iconOnly && (
        <span
          className="active-chip-frame pointer-events-none absolute inset-0 z-[2] rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(115,115,115,0.2)] [corner-shape:squircle]"
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
                dupeCount > 9 && 'chip-dupe-badge-wide w-auto rounded-lg px-1 [corner-shape:squircle]'
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
            chip.pathSuffix && 'max-h-[calc(3lh)]'
          )}
          ref={chipTextRef}
        >
          {isFolded && (
            <span className="chip-env-stack mr-1.5 inline-flex gap-[3px] align-baseline">
              {envs.map((env) => {
                const envLabel = `Focus ${env.prefix} tab${env.activeInOtherWindow ? ' (active in another window)' : ''}`
                return (
                  <TooltipAnchor key={env.rawUrl || env.tabUrl} content={envLabel}>
                    <button
                      type="button"
                      className={cn(
                        "chip-env clickable inline-flex cursor-pointer items-center rounded-lg border-0 bg-[rgba(115,115,115,0.05)] px-1.5 text-xs leading-[inherit] font-medium text-tab-muted transition-[background,color,box-shadow] duration-150 ease-in-out [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.'] hover:bg-[rgba(10,10,10,0.12)] hover:text-tab-ink",
                        env.activeInOtherWindow && 'bg-[rgba(82,82,82,0.13)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]'
                      )}
                      aria-label={envLabel}
                      onClick={(e) => onEnvClick(e, env)}
                      onKeyDown={(e) => onEnvKeyDown(e, env)}
                      onMouseEnter={() => onEnvMouseEnter(env)}
                      onMouseLeave={onEnvMouseLeave}
                      onFocus={() => onEnvFocus(env)}
                      onBlur={onEnvBlur}
                    >
                      {renderHighlightedText(env.prefix, filter, `env-${env.prefix}`)}
                    </button>
                  </TooltipAnchor>
                )
              })}
            </span>
          )}
          {!isFolded && chip.leadPrefix && (
            <span className="chip-subdomain mr-1.5 font-medium text-tab-muted after:ml-1.5 after:opacity-50 after:content-['·']">
              {renderHighlightedText(chip.leadPrefix, filter, 'lead')}
            </span>
          )}
          {chip.pathGroupLabel && (
            <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]">
              {renderHighlightedText(chip.pathGroupLabel, filter, 'pathgroup')}
            </span>
          )}
          {chip.displaySegments.map((seg, index) => (typeof seg === 'string' ? renderHighlightedText(seg, filter, `segment-${index}`) : (
            <span
              key={index}
              className="chip-strip-indicator inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]"
              aria-hidden="true"
            >
              ~
            </span>
          )))}
          {chip.pathSuffix && <span className="chip-path ml-1.5 inline-block whitespace-nowrap text-xs font-normal text-tab-muted opacity-75">{renderHighlightedText(chip.pathSuffix, filter, 'path')}</span>}
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
