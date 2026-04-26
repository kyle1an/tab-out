/* ================================================================
   <HeaderStats> — Preact component for the pinned-top stats row.

   Renders the tab count ("182 tabs" + "3 windows"), the domain count
   ("17 domains"), the global Dedupe-N button, and the
   Close-N-filtered-tabs button. Props are derived by the App root
   from the same view-model inputs that drive the card grid.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'

const html = htm.bind(h)

function pluralize(count, singular) {
  return `${singular}${count === 1 ? '' : 's'}`
}

export function HeaderStats({
  ready = true,
  source = 'tabs',
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

  const itemName = source === 'bookmarks' ? 'bookmark' : source === 'history' ? 'history result' : 'tab'
  const itemLabel = pluralize(totalTabs, itemName)
  const tabsLabel = filtering ? `${visibleTabs}/${totalTabs} ${itemLabel}` : `${totalTabs} ${itemLabel}`
  const windowsLabel =
    visibleWindows === totalWindows ? `${totalWindows} ${pluralize(totalWindows, 'window')}` : `${visibleWindows}/${totalWindows} ${pluralize(totalWindows, 'window')}`
  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} ${pluralize(totalDomains, 'domain')}` : `${visibleDomains}/${totalDomains} ${pluralize(totalDomains, 'domain')}`

  const dedupTitle = `Close ${dedupCount} duplicate${dedupCount !== 1 ? 's' : ''}`
  const closeFilteredTitle = `Close ${filteredCloseCount} filtered tab${filteredCloseCount !== 1 ? 's' : ''}`

  return html`
    <div class="header-stats">
      <span class="stat-primary" id="greeting">${tabsLabel}</span>
      ${source === 'tabs' &&
      dedupCount > 0 &&
      html`
        <button class="action-btn" title=${dedupTitle} onClick=${onDedupAll}>
          Dedupe ${dedupCount}
        </button>
      `}
      ${source === 'tabs' &&
      html`
        <span class="stat-sep">·</span>
        <span class="date" id="dateDisplay">${windowsLabel}</span>
      `}
      ${hasCards &&
      html`
        <span class="stat-extras" id="sectionHeaderWrap">
          <span class="stat-sep">·</span>
          <span class="section-count" id="openTabsSectionCount">${domainsLabel}</span>
        </span>
      `}
      ${source === 'tabs' &&
      filteredCloseCount > 0 &&
      html`
        <button class="action-btn close-tabs" title=${closeFilteredTitle} onClick=${onCloseFiltered}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close ${filteredCloseCount}
        </button>
      `}
    </div>
  `
}
