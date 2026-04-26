/* ================================================================
   <PageChip> — Phase 5 of the Preact + HTM migration.

   Renders one tab chip. Props take a pre-computed `chip` data
   object (see buildChipData in render.js) so the component itself
   stays view-only: favicon img, chip-text with optional subdomain /
   path-group / path suffix spans, optional "(Nx)" dupe badge, and
   an X close button.

   Event handlers:
     • Clicking the chip focuses the tab (focusTab by URL).
     • Clicking the close button removes the tab, plays the fade-out
       animation, re-packs masonry, and pushes a closure
       onto the undo stack.

   data-action="focus-tab" and data-action="close-single-tab" are
   kept on the rendered elements as stable selector anchors, but all
   focus / close / preview behavior is component-local.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useLayoutEffect, useRef } from '../vendor/preact-hooks.mjs'
import { focusExactTab, focusTab, fetchOpenTabs, openTabUrl, snapshotChromeTabs } from '../tabs.js'
import { requestDashboardRefresh } from '../dashboard-controller.js'
import { unwrapSuspenderUrl } from '../suspender.js'
import { deleteHistorySourceUrl } from '../history-source.js'
import { markClosure } from '../undo.js'
import { showToast } from './Toast.js'

const html = htm.bind(h)
let chipTextResizeObserver = null

function isChipTextTruncated(textEl) {
  if (!textEl) return false
  return textEl.scrollHeight - textEl.clientHeight > 1
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
  const chipTextRef = useRef(null)

  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    let frameId = requestAnimationFrame(() => syncChipTextFade(textEl))
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
    // Folded chip: clicking the chip body focuses the first env. Use
    // env-pill clicks to pick a specific one.
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

  // Capture chipEl before any await — e.currentTarget is only
  // valid during synchronous event dispatch.
  async function onClose(e) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')

    // Folded chip: close every env copy at once. Regular chip: match
    // on both raw and effective URL (handles (un)suspended tabs) and
    // close only the first match — siblings with the same URL survive
    // and the (Nx) badge decrements on re-render.
    const allTabs = await chrome.tabs.query({})
    let toCloseList = []
    let matchCount = 0
    if (isFolded) {
      const targetEffectives = new Set(chip.envs.map((e) => unwrapSuspenderUrl(e.tabUrl)))
      const targetUrls = new Set(chip.envs.map((e) => e.tabUrl))
      toCloseList = allTabs.filter((t) => targetUrls.has(t.url) || targetEffectives.has(unwrapSuspenderUrl(t.url)))
      matchCount = toCloseList.length
    } else {
      const targetEffective = unwrapSuspenderUrl(chip.tabUrl)
      const matches = allTabs.filter((t) => t.url === chip.tabUrl || unwrapSuspenderUrl(t.url) === targetEffective)
      toCloseList = matches.slice(0, 1)
      matchCount = matches.length
    }
    const snapshot = toCloseList.length > 0 ? snapshotChromeTabs(toCloseList) : []
    for (const t of toCloseList) {
      try {
        await chrome.tabs.remove(t.id)
      } catch {}
    }
    await fetchOpenTabs()

    // Folded chip: we closed every env in one go, so the chip is
    // done either way. Regular chip: only "last tab for this URL"
    // when there was just one match — otherwise siblings survive
    // and the (Nx) badge needs to decrement via a fresh re-render.
    const isLastTabForUrl = isFolded || matchCount <= 1

    if (isLastTabForUrl && chipEl) {
      // Only tab for this URL is gone — animate the chip out via
      // the shared `.closing` CSS class, then let the next dashboard
      // refresh rebuild the VM. Preact drops the chip from the tree (and, if
      // the card ended up empty, the card too) without us having to
      // traverse the DOM looking for empty .mission-pages.
      chipEl.classList.add('closing')
      await new Promise((r) => setTimeout(r, 200))
    }

    // Full re-render handles both branches: last tab → chip gone
    // from VM, card may collapse too; duplicate set → (Nx) badge
    // decrements via the fresh VM.
    setPreview('')
    await requestDashboardRefresh()

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
    const urls = Array.from(new Set(isFolded ? chip.envs.map((env) => env.tabUrl).filter(Boolean) : [chip.tabUrl].filter(Boolean)))
    if (urls.length === 0) return

    const results = await Promise.all(urls.map((url) => deleteHistorySourceUrl(url)))
    const deletedCount = results.filter(Boolean).length
    if (deletedCount === 0) {
      showToast('Could not delete history')
      return
    }

    chipEl?.classList.add('closing')
    await new Promise((r) => setTimeout(r, 200))
    setPreview('')
    await requestDashboardRefresh()
    showToast(deletedCount === 1 ? 'History deleted' : `Deleted ${deletedCount} history items`)
  }

  const style = chip.isGrouped ? `--group-color:${chip.groupDotColor}` : null
  // data-tab-url is read by app.js's URL-preview hover handler. For a
  // folded chip we join all env URLs so the preview can fall back to
  // the first one while any env pill shows its own specific URL.
  const dataTabUrl = isFolded ? chip.envs.map((e) => e.tabUrl).join(' ') : chip.tabUrl

  return html`
    <div
      class=${'page-chip clickable' + (isFolded ? ' page-chip-folded' : '') + (chip.iconOnly ? ' page-chip-icon-only' : '')}
      data-action="focus-tab"
      data-tab-url=${dataTabUrl}
      title=${chip.tooltip}
      aria-label=${chip.tooltip}
      style=${style}
      tabIndex="0"
      onClick=${onFocus}
      onKeyDown=${onChipKeyDown}
      onMouseEnter=${onChipMouseEnter}
      onMouseLeave=${onChipMouseLeave}
      onFocus=${onChipFocus}
      onBlur=${onChipBlur}
    >
      ${chip.faviconUrl &&
      html`
        <span class=${'chip-favicon-frame' + (chip.isApp ? ' is-app' : '')}>
          <img class="chip-favicon" src=${chip.faviconUrl} alt="" />
        </span>
      `}
      ${!chip.iconOnly &&
      html`
        <span class="chip-text" ref=${chipTextRef}>
          ${isFolded &&
          html`
            <span class="chip-env-stack">
              ${chip.envs.map(
                (env) => html`
                  <span
                    class="chip-env clickable"
                    data-action="focus-env"
                    data-tab-url=${env.tabUrl}
                    title=${`Focus ${env.prefix} tab`}
                    tabIndex="0"
                    onClick=${(e) => onEnvClick(e, env)}
                    onKeyDown=${(e) => onEnvKeyDown(e, env)}
                    onMouseEnter=${() => onEnvMouseEnter(env)}
                    onMouseLeave=${onEnvMouseLeave}
                    onFocus=${() => onEnvFocus(env)}
                    onBlur=${onEnvBlur}
                  >
                    ${env.prefix}
                  </span>
                `
              )}
            </span>
          `}
          ${!isFolded && chip.leadPrefix && html` <span class="chip-subdomain">${chip.leadPrefix}</span> `}
          ${chip.pathGroupLabel && html` <span class="chip-pathgroup">${chip.pathGroupLabel}</span> `}
          ${chip.displaySegments.map((seg) => (typeof seg === 'string' ? seg : html`<span class="chip-strip-indicator" aria-hidden="true">~</span>`))}
          ${chip.pathSuffix && html` <span class="chip-path">${chip.pathSuffix}</span> `}
        </span>
      `}
      ${!chip.iconOnly && chip.dupeCount > 1 && html` <span class="chip-dupe-badge">(${chip.dupeCount}x)</span> `}
      ${!chip.iconOnly &&
      (!isReadOnlySource || isHistorySource) &&
      html`
        <div class="chip-actions">
          <button
            class="chip-action chip-close"
            data-action=${isHistorySource ? 'delete-history-url' : 'close-single-tab'}
            data-tab-url=${chip.tabUrl}
            title=${isHistorySource ? 'Delete from history' : 'Close this tab'}
            aria-label=${isHistorySource ? 'Delete from history' : 'Close this tab'}
            onClick=${isHistorySource ? onDeleteHistory : onClose}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      `}
    </div>
  `
}
