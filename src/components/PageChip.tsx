import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent } from 'react'
import { focusExactTab, focusTab, fetchOpenTabs, openTabUrl, snapshotChromeTabs } from '../extension/tabs.js'
import { requestDashboardRefresh } from '../extension/dashboard-controller.js'
import { unwrapSuspenderUrl } from '../extension/suspender.js'
import { deleteHistorySourceUrl } from '../extension/history-source.js'
import { markClosure } from '../extension/undo.js'
import { showToast } from '../extension/toast.js'
import { Button } from './ui/Button'
import { cn } from '../lib/cn'
import type { DashboardChipData, HoverUrlChangeHandler } from './types'
import type { DashboardChipEnv } from '../extension/types'

let chipTextResizeObserver: ResizeObserver | null = null

interface PageChipProps {
  chip: DashboardChipData
  onHoverUrlChange?: HoverUrlChangeHandler | null
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

export function PageChip({ chip, onHoverUrlChange = null }: PageChipProps) {
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
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

    const allTabs = await chrome.tabs.query({})
    let toCloseList: chrome.tabs.Tab[] = []
    let matchCount = 0
    if (isFolded) {
      const targetEffectives = new Set(envs.map((env) => unwrapSuspenderUrl(env.tabUrl)))
      const targetUrls = new Set(envs.map((env) => env.tabUrl))
      toCloseList = allTabs.filter((tab) => {
        const tabUrl = tab.url || ''
        return targetUrls.has(tabUrl) || targetEffectives.has(unwrapSuspenderUrl(tabUrl))
      })
      matchCount = toCloseList.length
    } else {
      const targetEffective = unwrapSuspenderUrl(chip.tabUrl)
      const matches = allTabs.filter((tab) => {
        const tabUrl = tab.url || ''
        return tabUrl === chip.tabUrl || unwrapSuspenderUrl(tabUrl) === targetEffective
      })
      toCloseList = matches.slice(0, 1)
      matchCount = matches.length
    }
    const snapshot = toCloseList.length > 0 ? snapshotChromeTabs(toCloseList) : []
    for (const tab of toCloseList) {
      if (typeof tab.id !== 'number') continue
      try {
        await chrome.tabs.remove(tab.id)
      } catch {}
    }
    await fetchOpenTabs()

    const isLastTabForUrl = isFolded || matchCount <= 1

    if (isLastTabForUrl && chipEl) {
      chipEl.classList.add('closing')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    setPreview('')
    await requestDashboardRefresh({ animateCards: true })

    if (snapshot.length > 0) {
      const label = isFolded ? `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} across subdomains` : 'Tab closed'
      markClosure(snapshot, label)
    } else {
      showToast('Nothing to close')
    }
  }

  async function onDeleteHistory(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const urls: string[] = Array.from(new Set(isFolded ? envs.map((env) => env.tabUrl).filter(Boolean) : [chip.tabUrl].filter(Boolean)))
    if (urls.length === 0) return

    const results = await Promise.all(urls.map((url) => deleteHistorySourceUrl(url)))
    const deletedCount = results.filter(Boolean).length
    if (deletedCount === 0) {
      showToast('Could not delete history')
      return
    }

    chipEl?.classList.add('closing')
    await new Promise((resolve) => setTimeout(resolve, 200))
    setPreview('')
    await requestDashboardRefresh({ animateCards: true })
    showToast(deletedCount === 1 ? 'History deleted' : `Deleted ${deletedCount} history items`)
  }

  const style = chip.isGrouped ? ({ '--group-color': chip.groupDotColor } as CSSProperties) : undefined
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const chipLabel = [chip.tooltip, duplicateLabel].filter(Boolean).join(' · ')

  return (
    <div
      className={cn(
        "page-chip clickable group/page-chip relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight text-[var(--ink)] [font-family:inherit] [corner-shape:squircle] transition-colors duration-150 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] hover:bg-[rgba(82,82,82,0.04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-200 [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.8)]",
        isFolded && 'page-chip-folded after:hidden',
        chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 overflow-hidden rounded-xl border-0 bg-transparent p-0 [corner-shape:squircle] [outline:1px_solid_rgba(115,115,115,0.18)] outline-offset-[1px] before:hidden after:hidden',
        chip.iconOnly && chip.isApp && 'overflow-visible outline-none'
      )}
      title={chipLabel}
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
            chip.pathSuffix && 'max-h-[calc(3lh)]'
          )}
          ref={chipTextRef}
        >
          {isFolded && (
            <span className="chip-env-stack mr-1.5 inline-flex gap-[3px] align-baseline">
              {envs.map((env) => (
                <Button
                  key={env.rawUrl || env.tabUrl}
                  className="chip-env clickable inline-flex cursor-pointer items-center rounded-lg border-0 bg-[rgba(115,115,115,0.05)] px-1.5 text-xs leading-[inherit] font-medium text-tab-muted transition-[background,color] duration-150 ease-in-out [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.'] hover:bg-[rgba(10,10,10,0.12)] hover:text-tab-ink"
                  title={`Focus ${env.prefix} tab`}
                  onClick={(e) => onEnvClick(e, env)}
                  onKeyDown={(e) => onEnvKeyDown(e, env)}
                  onMouseEnter={() => onEnvMouseEnter(env)}
                  onMouseLeave={onEnvMouseLeave}
                  onFocus={() => onEnvFocus(env)}
                  onBlur={onEnvBlur}
                >
                  {env.prefix}
                </Button>
              ))}
            </span>
          )}
          {!isFolded && chip.leadPrefix && (
            <span className="chip-subdomain mr-1.5 font-medium text-tab-muted after:ml-1.5 after:opacity-50 after:content-['·']">{chip.leadPrefix}</span>
          )}
          {chip.pathGroupLabel && (
            <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]">
              {chip.pathGroupLabel}
            </span>
          )}
          {chip.displaySegments.map((seg, index) => (typeof seg === 'string' ? seg : (
            <span
              key={index}
              className="chip-strip-indicator inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]"
              aria-hidden="true"
            >
              ~
            </span>
          )))}
          {chip.pathSuffix && <span className="chip-path ml-1.5 inline-block whitespace-nowrap text-xs font-normal text-tab-muted opacity-75">{chip.pathSuffix}</span>}
        </span>
      )}
      {!chip.iconOnly && !isFolded && (!isReadOnlySource || isHistorySource) && (
        <div className="chip-actions absolute top-1/2 right-2 z-[2] flex -translate-y-1/2 items-center gap-0.5">
          <Button
            className="chip-action chip-close pointer-events-none inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-1 text-tab-muted opacity-0 transition-[opacity,color,background] duration-150 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 hover:bg-[rgba(82,82,82,0.1)] hover:opacity-100"
            title={isHistorySource ? 'Delete from history' : 'Close this tab'}
            aria-label={isHistorySource ? 'Delete from history' : 'Close this tab'}
            onClick={isHistorySource ? onDeleteHistory : onClose}
          >
            <svg className="h-[15px] w-[15px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>
      )}
    </div>
  )
}
