/* ================================================================
   <PathgroupSection> — Phase 4–5 of the Preact + HTM migration.

   Renders one path-group cluster inside a subdomain section: a
   labeled header (pill + count + ruled separator + optional close
   button) plus visible <PageChip>s, with hidden chips revealed in
   place via a local "+N more" expander.

   Both the expand state (useState) and the cluster-level close
   handler live on the component — the previous app.js delegation
   cases `expand-chips` (for pathgroup-section) and
   `close-pathgroup-tabs` are retired. The component's stable key
   (its label, assigned by the parent's list render) preserves the
   useState across live-sync re-renders, so render.js no longer
   snapshots or restores expansion state.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useState } from '../vendor/preact-hooks.mjs'
import { closeTabsExact } from '../tabs.js'
import { requestDashboardRefresh } from '../dashboard-controller.js'
import { markClosure } from '../undo.js'
import { PageChip } from './PageChip.js'

const html = htm.bind(h)

function PathgroupCloseButton({ count, onClick }) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return html`
    <button class="pathgroup-close-btn" title=${title} onClick=${onClick}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `
}

export function PathgroupSection({ label, isPR, count, closableUrls, visibleChips, hiddenChips, hiddenCount, onHoverUrlChange = null, onLayoutChange = null }) {
  const [expanded, setExpanded] = useState(false)

  function onExpand() {
    setExpanded(true)
    if (onLayoutChange) onLayoutChange()
  }

  // Close-cluster handler. Exact-URL matching + preserveGroups
  // means sibling tabs on the same host and Chrome-grouped tabs
  // are untouched.
  async function onCloseCluster() {
    if (!closableUrls || closableUrls.length === 0) return
    const snapshot = await closeTabsExact(closableUrls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    }
    await requestDashboardRefresh()
  }

  return html`
    <div class="pathgroup-section" data-expanded=${expanded ? 'true' : null}>
      <div class="pathgroup-header">
        <span class="chip-pathgroup" title=${label}>${label}</span>
        ${isPR && html`<span class="chip-pathgroup chip-pathgroup-pr">PRs</span>`}
        <span class="pathgroup-header-count">${count}</span>
        <span class="pathgroup-header-rule"></span>
        ${closableUrls && closableUrls.length > 0 && html` <${PathgroupCloseButton} count=${closableUrls.length} onClick=${onCloseCluster} /> `}
      </div>
      ${visibleChips.map((chip) => html` <${PageChip} key=${chip.rawUrl} chip=${chip} onHoverUrlChange=${onHoverUrlChange} /> `)}
      ${hiddenCount > 0 &&
      html` <div class="page-chips-overflow">${hiddenChips.map((chip) => html` <${PageChip} key=${chip.rawUrl} chip=${chip} onHoverUrlChange=${onHoverUrlChange} /> `)}</div> `}
      ${!expanded &&
      hiddenCount > 0 &&
      html`
        <div class="page-chip page-chip-overflow clickable" onClick=${onExpand}>
          <span class="chip-text">+${hiddenCount} more</span>
        </div>
      `}
    </div>
  `
}
