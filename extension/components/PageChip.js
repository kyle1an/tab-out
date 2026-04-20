/* ================================================================
   <PageChip> — Phase 5 of the Preact + HTM migration.

   Renders one tab chip. Props take a pre-computed `chip` data
   object (see buildChipData in render.js) so the component itself
   stays view-only: favicon img, chip-text with optional subdomain /
   path-group / path suffix spans, optional "(Nx)" dupe badge, and
   an X close button.

   Event handlers:
     • Clicking the chip focuses the tab (focusTab by URL).
     • Clicking the close button removes the tab, plays the confetti
       + fade-out animation, re-packs masonry, and pushes a closure
       onto the undo stack.

   data-action="focus-tab" and data-action="close-single-tab" are
   kept on the rendered elements as selector anchors. filter.js
   queries `.page-chip[data-action="focus-tab"]` to find filterable
   chips, and the post-close "is this card empty now?" check uses
   the same selector to decide whether to animate the whole card
   out. The app.js delegation cases for those data-actions are
   retired in this phase — click handling is now component-local.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { focusTab, fetchOpenTabs, snapshotChromeTabs } from '../tabs.js'
import { unwrapSuspenderUrl } from '../suspender.js'
import { markClosure } from '../undo.js'
import { showToast } from '../ui.js'
import { shootConfetti } from '../confetti.js'
import { renderStaticDashboard } from '../render.js'

const html = htm.bind(h)

export function PageChip({ chip }) {
  const isFolded = Array.isArray(chip.envs) && chip.envs.length > 0

  async function onFocus() {
    // Folded chip: clicking the chip body focuses the first env. Use
    // env-pill clicks to pick a specific one.
    const targetUrl = isFolded ? chip.envs[0].tabUrl : chip.tabUrl
    if (targetUrl) await focusTab(targetUrl)
  }

  async function onEnvClick(e, env) {
    e.stopPropagation()
    if (env.tabUrl) await focusTab(env.tabUrl)
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
      // the shared `.closing` CSS class, then let renderStaticDashboard
      // rebuild the VM. Preact drops the chip from the tree (and, if
      // the card ended up empty, the card too) without us having to
      // traverse the DOM looking for empty .mission-pages.
      const rect = chipEl.getBoundingClientRect()
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2)
      chipEl.classList.add('closing')
      await new Promise((r) => setTimeout(r, 200))
    }

    // Always full re-render at this point — handles both branches:
    //   • last tab: chip is gone from the VM, card may collapse too
    //   • duplicate set: (Nx) badge decrements via the fresh VM
    // Subsumes the previous split updateTabCountDisplays +
    // packMissionsMasonry + per-card DOM probing.
    await renderStaticDashboard()

    if (snapshot.length > 0) {
      const label = isFolded ? `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} across subdomains` : 'Tab closed'
      markClosure(snapshot, label)
    } else {
      showToast('Nothing to close')
    }
  }

  const style = chip.isGrouped ? `--group-color:${chip.groupDotColor}` : null
  // Filter-matching reads data-tab-url. For a folded chip we join all
  // env URLs so "dev11us" or "qaus" in the filter box still matches
  // this chip (even though the chip's primary URL is dev2us's).
  const dataTabUrl = isFolded ? chip.envs.map((e) => e.tabUrl).join(' ') : chip.tabUrl
  // data-tab-count is the number of underlying tabs this single chip
  // stands for — envs.length for a folded cross-env chip, dupeCount
  // for a regular chip carrying an (Nx) badge, else 1. filter.js
  // sums this across visible chips so header counts read in tabs
  // (matching the unfiltered view) instead of chips.
  const dataTabCount = isFolded ? chip.envs.length : chip.dupeCount || 1

  return html`
    <div class="page-chip clickable ${isFolded ? 'page-chip-folded' : ''}" data-action="focus-tab" data-tab-url=${dataTabUrl} data-tab-count=${dataTabCount} title=${chip.tooltip} style=${style} onClick=${onFocus}>
      ${chip.faviconUrl && html` <img class="chip-favicon" src=${chip.faviconUrl} alt="" /> `}
      <span class="chip-text">
        ${isFolded &&
        html`
          <span class="chip-env-stack">
            ${chip.envs.map(
              (env) => html`
                <span class="chip-env clickable" data-action="focus-env" data-tab-url=${env.tabUrl} title=${`Focus ${env.prefix} tab`} onClick=${(e) => onEnvClick(e, env)}>${env.prefix}</span>
              `
            )}
          </span>
        `}
        ${!isFolded && chip.leadPrefix && html` <span class="chip-subdomain">${chip.leadPrefix}</span> `}
        ${chip.pathGroupLabel && html` <span class="chip-pathgroup">${chip.pathGroupLabel}</span> `}
        ${chip.displaySegments.map((seg) => (typeof seg === 'string' ? seg : html`<span class="chip-strip-indicator" aria-hidden="true">~</span>`))}
        ${chip.pathSuffix && html` <span class="chip-path">${chip.pathSuffix}</span> `}
      </span>
      ${chip.dupeCount > 1 && html` <span class="chip-dupe-badge">(${chip.dupeCount}x)</span> `}
      ${!isFolded &&
      html`
        <div class="chip-actions">
          <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url=${chip.tabUrl} title="Close this tab" onClick=${onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      `}
    </div>
  `
}
