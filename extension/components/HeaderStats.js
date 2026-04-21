/* ================================================================
   <HeaderStats> — Preact component for the pinned-top stats row.

   Renders the tab count ("182 Open tabs" + "Across 3 windows"), the
   domain count ("17 domains"), the global Dedupe-N button, and the
   Close-N-filtered-tabs button. Props are derived by the App root
   from the same view-model inputs that drive the card grid.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'

const html = htm.bind(h)

export function HeaderStats({
  ready = true,
  totalTabs,
  visibleTabs,
  totalWindows,
  visibleWindows,
  totalDomains,
  visibleDomains,
  dedupCount,
  filteredCloseCount,
  hasCards,
  filtering,
  onDedupAll,
  onCloseFiltered
}) {
  if (!ready) {
    return html`<div class="header-stats" aria-hidden="true"></div>`
  }

  const tabsLabel = filtering ? `${visibleTabs} of ${totalTabs} Open tab${totalTabs !== 1 ? 's' : ''}` : `${totalTabs} Open tab${totalTabs !== 1 ? 's' : ''}`

  const windowsLabel =
    visibleWindows === totalWindows
      ? `Across ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`
      : `Across ${visibleWindows} of ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`

  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} domain${totalDomains !== 1 ? 's' : ''}` : `${visibleDomains} of ${totalDomains} domain${totalDomains !== 1 ? 's' : ''}`

  const dedupTitle = `Close ${dedupCount} duplicate${dedupCount !== 1 ? 's' : ''}`

  return html`
    <div class="header-stats">
      ${dedupCount > 0 &&
      html`
        <button class="action-btn" title=${dedupTitle} style="font-size:11px;padding:4px 12px;" onClick=${onDedupAll}>
          Dedupe ${dedupCount}
        </button>
      `}
      <span class="stat-primary" id="greeting">${tabsLabel}</span>
      <span class="stat-sep">·</span>
      <span class="date" id="dateDisplay">${windowsLabel}</span>
      ${hasCards &&
      html`
        <span class="stat-extras" id="sectionHeaderWrap">
          <span class="stat-sep">·</span>
          <span class="section-count" id="openTabsSectionCount">${domainsLabel}</span>
        </span>
      `}
      ${filteredCloseCount > 0 &&
      html`
        <button class="action-btn close-tabs" style="font-size:11px;padding:4px 12px;" onClick=${onCloseFiltered}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close ${filteredCloseCount} filtered tab${filteredCloseCount !== 1 ? 's' : ''}
        </button>
      `}
    </div>
  `
}
