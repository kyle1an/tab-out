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
import { showToast, animateCardOut } from '../ui.js'
import { shootConfetti } from '../confetti.js'
import { packMissionsMasonry } from '../layout.js'
import { updateTabCountDisplays, renderStaticDashboard } from '../render.js'

const html = htm.bind(h)

export function PageChip({ chip }) {
  async function onFocus() {
    if (chip.tabUrl) await focusTab(chip.tabUrl)
  }

  // Capture chipEl before any await — e.currentTarget is only
  // valid during synchronous event dispatch.
  async function onClose(e) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')

    // Match on both raw and effective URL so the chip works even if
    // the tab has been (un)suspended since the last render. Collect
    // ALL matches (a chip with an (Nx) dupe badge represents >1 tab
    // at the same URL) so we can distinguish "removed the last tab
    // for this URL" from "still have siblings to render".
    const allTabs = await chrome.tabs.query({})
    const targetEffective = unwrapSuspenderUrl(chip.tabUrl)
    const matches = allTabs.filter((t) => t.url === chip.tabUrl || unwrapSuspenderUrl(t.url) === targetEffective)
    const toClose = matches[0]
    const snapshot = toClose ? snapshotChromeTabs([toClose]) : []
    if (toClose) await chrome.tabs.remove(toClose.id)
    await fetchOpenTabs()

    const isLastTabForUrl = matches.length <= 1

    if (isLastTabForUrl) {
      // Only tab for this URL is gone — animate the chip out and
      // cascade to animateCardOut if the card is now empty.
      if (chipEl) {
        const rect = chipEl.getBoundingClientRect()
        shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2)
        chipEl.style.transition = 'opacity 0.2s, transform 0.2s'
        chipEl.style.opacity = '0'
        chipEl.style.transform = 'scale(0.8)'
        setTimeout(() => {
          chipEl.remove()
          const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)')
          if (parentCard) animateCardOut(parentCard)
          document.querySelectorAll('.mission-card').forEach((c) => {
            if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
              animateCardOut(c)
            }
          })
          packMissionsMasonry()
        }, 200)
      }
    } else {
      // Chip represented a duplicate set (e.g. "(2x)" badge). Closing
      // one of them should shrink the badge, not remove the chip —
      // the remaining sibling tab(s) still exist and must stay
      // represented in the UI. Re-rendering the whole dashboard is
      // the safe fix: computeDomainCardViewModel re-derives counts,
      // card-level tab-count badges update, and the (Nx) badge
      // either decrements or disappears for (N-1) ≤ 1. Previously
      // the chipEl was animated out unconditionally, silently
      // hiding the survivor until a manual refresh.
      renderStaticDashboard()
    }

    updateTabCountDisplays()

    if (snapshot.length > 0) markClosure(snapshot, 'Tab closed')
    else showToast('Tab closed')
  }

  const style = chip.isGrouped ? `--group-color:${chip.groupDotColor}` : null

  return html`
    <div class="page-chip clickable" data-action="focus-tab" data-tab-url=${chip.tabUrl} title=${chip.tooltip} style=${style} onClick=${onFocus}>
      ${chip.faviconUrl && html` <img class="chip-favicon" src=${chip.faviconUrl} alt="" /> `}
      <span class="chip-text">
        ${chip.leadPrefix && html` <span class="chip-subdomain">${chip.leadPrefix}</span> `}
        ${chip.pathGroupLabel && html` <span class="chip-pathgroup">${chip.pathGroupLabel}</span> `}
        ${chip.displaySegments.map((seg) => (typeof seg === 'string' ? seg : html`<span class="chip-strip-indicator" aria-hidden="true">~</span>`))}
        ${chip.pathSuffix && html` <span class="chip-path">${chip.pathSuffix}</span> `}
      </span>
      ${chip.dupeCount > 1 && html` <span class="chip-dupe-badge">(${chip.dupeCount}x)</span> `}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url=${chip.tabUrl} title="Close this tab" onClick=${onClose}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  `
}
