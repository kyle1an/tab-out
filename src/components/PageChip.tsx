import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { focusExactTab, focusTab, fetchOpenTabs, openTabUrl, snapshotChromeTabs } from '../../extension/tabs.js'
import { requestDashboardRefresh } from '../../extension/dashboard-controller.js'
import { unwrapSuspenderUrl } from '../../extension/suspender.js'
import { deleteHistorySourceUrl } from '../../extension/history-source.js'
import { markClosure } from '../../extension/undo.js'
import { showToast } from '../../extension/toast.js'

let chipTextResizeObserver = null

function isChipTextTruncated(textEl) {
  if (!textEl) return false
  return (
    textEl.scrollHeight - textEl.clientHeight > 1 ||
    textEl.scrollWidth - textEl.clientWidth > 1
  )
}

function syncChipTextFade(textEl) {
  if (!textEl) return
  textEl.classList.toggle('chip-text-truncated', isChipTextTruncated(textEl))
}

function getChipTextResizeObserver() {
  if (typeof ResizeObserver !== 'function') return null
  if (!chipTextResizeObserver) {
    chipTextResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) syncChipTextFade(entry.target)
    })
  }
  return chipTextResizeObserver
}

export function PageChip({ chip, onHoverUrlChange = null }) {
  const isFolded = Array.isArray(chip.envs) && chip.envs.length > 0
  const isHistorySource = chip.sourceType === 'history'
  const isReadOnlySource = chip.sourceType === 'bookmark' || isHistorySource
  const primaryPreviewUrl = isFolded ? chip.envs[0]?.tabUrl || '' : chip.tabUrl || ''
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

  function isKeyboardActivation(e) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function onFocus() {
    const targetUrl = isFolded ? chip.envs[0].tabUrl : chip.tabUrl
    if (!targetUrl) return
    if (isReadOnlySource) {
      const focused = await focusExactTab(targetUrl)
      if (!focused) await openTabUrl(targetUrl)
      return
    }
    await focusTab(targetUrl)
  }

  async function onChipKeyDown(e) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus()
  }

  async function onEnvClick(e, env) {
    e.stopPropagation()
    if (!env.tabUrl) return
    if (isReadOnlySource) {
      const focused = await focusExactTab(env.tabUrl)
      if (!focused) await openTabUrl(env.tabUrl)
      return
    }
    await focusTab(env.tabUrl)
  }

  async function onEnvKeyDown(e, env) {
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

  function setPreview(url) {
    if (onHoverUrlChange) onHoverUrlChange(url || '')
  }

  function onChipMouseEnter() {
    setPreview(primaryPreviewUrl)
  }

  function onChipMouseLeave(e) {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onChipFocus() {
    setPreview(primaryPreviewUrl)
  }

  function onChipBlur(e) {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setPreview('')
  }

  function onEnvMouseEnter(env) {
    setPreview(env.tabUrl)
  }

  function onEnvMouseLeave(e) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    setPreview('')
  }

  function onEnvFocus(env) {
    setPreview(env.tabUrl)
  }

  function onEnvBlur(e) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl)
      return
    }
    setPreview('')
  }

  async function onClose(e) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')

    const allTabs = await chrome.tabs.query({})
    let toCloseList = []
    let matchCount = 0
    if (isFolded) {
      const targetEffectives = new Set(chip.envs.map((env) => unwrapSuspenderUrl(env.tabUrl)))
      const targetUrls = new Set(chip.envs.map((env) => env.tabUrl))
      toCloseList = allTabs.filter((tab) => targetUrls.has(tab.url) || targetEffectives.has(unwrapSuspenderUrl(tab.url)))
      matchCount = toCloseList.length
    } else {
      const targetEffective = unwrapSuspenderUrl(chip.tabUrl)
      const matches = allTabs.filter((tab) => tab.url === chip.tabUrl || unwrapSuspenderUrl(tab.url) === targetEffective)
      toCloseList = matches.slice(0, 1)
      matchCount = matches.length
    }
    const snapshot = toCloseList.length > 0 ? snapshotChromeTabs(toCloseList) : []
    for (const tab of toCloseList) {
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

  async function onDeleteHistory(e) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const urls: string[] = Array.from(new Set(isFolded ? chip.envs.map((env) => env.tabUrl).filter(Boolean) : [chip.tabUrl].filter(Boolean)))
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
  const dataTabUrl = isFolded ? chip.envs.map((env) => env.tabUrl).join(' ') : chip.tabUrl
  const dupeCount = chip.dupeCount || 1
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const chipLabel = [chip.tooltip, duplicateLabel].filter(Boolean).join(' · ')
  const dupeBadgeClass = 'chip-dupe-badge' + (dupeCount > 9 ? ' chip-dupe-badge-wide' : '')

  return (
    <div
      className={'page-chip clickable' + (isFolded ? ' page-chip-folded' : '') + (chip.iconOnly ? ' page-chip-icon-only' : '')}
      data-action="focus-tab"
      data-tab-url={dataTabUrl}
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
        <span className={'chip-favicon-frame' + (chip.isApp ? ' is-app' : '')}>
          <img className="chip-favicon" src={chip.faviconUrl} alt="" />
          {!chip.iconOnly && dupeCount > 1 && (
            <span className={dupeBadgeClass} aria-hidden="true">
              {dupeCount}
            </span>
          )}
        </span>
      )}
      {!chip.iconOnly && (
        <span className="chip-text" ref={chipTextRef}>
          {isFolded && (
            <span className="chip-env-stack">
              {chip.envs.map((env) => (
                <span
                  key={env.rawUrl || env.tabUrl}
                  className="chip-env clickable"
                  data-action="focus-env"
                  data-tab-url={env.tabUrl}
                  title={`Focus ${env.prefix} tab`}
                  tabIndex={0}
                  onClick={(e) => onEnvClick(e, env)}
                  onKeyDown={(e) => onEnvKeyDown(e, env)}
                  onMouseEnter={() => onEnvMouseEnter(env)}
                  onMouseLeave={onEnvMouseLeave}
                  onFocus={() => onEnvFocus(env)}
                  onBlur={onEnvBlur}
                >
                  {env.prefix}
                </span>
              ))}
            </span>
          )}
          {!isFolded && chip.leadPrefix && <span className="chip-subdomain">{chip.leadPrefix}</span>}
          {chip.pathGroupLabel && <span className="chip-pathgroup">{chip.pathGroupLabel}</span>}
          {chip.displaySegments.map((seg, index) => (typeof seg === 'string' ? seg : <span key={index} className="chip-strip-indicator" aria-hidden="true">~</span>))}
          {chip.pathSuffix && <span className="chip-path">{chip.pathSuffix}</span>}
        </span>
      )}
      {!chip.iconOnly && !isFolded && (!isReadOnlySource || isHistorySource) && (
        <div className="chip-actions">
          <button
            className="chip-action chip-close"
            data-action={isHistorySource ? 'delete-history-url' : 'close-single-tab'}
            data-tab-url={chip.tabUrl}
            title={isHistorySource ? 'Delete from history' : 'Close this tab'}
            aria-label={isHistorySource ? 'Delete from history' : 'Close this tab'}
            onClick={isHistorySource ? onDeleteHistory : onClose}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
