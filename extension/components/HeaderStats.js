/* ================================================================
   <HeaderStats> — Preact component for the pinned-top stats row.

   Replaces three imperative-DOM functions that used to live in
   render.js:
     • updateTabCountDisplays  ("182 Open tabs" + "Across 3 windows")
     • updateSectionCount      ("17 domains" + "Dedupe N" button)
     • updateFilteredActions   ("Close N filtered tabs" button)

   Single mount point: .header-stats. Props are snapshot values;
   renderHeaderStats() in render.js computes them from getRealTabs()
   + the #tabFilter value + the primary card grid's current DOM and
   calls preactRender.

   The filter input wrapper (.tab-filter-wrap) is a SIBLING of the
   mount point — untouched by this render.

   Two counts still peek at DOM (visibleDomains, dedupCount) because
   they depend on per-card state that currently lives outside this
   component tree; elevating them into the view-model is a follow-up.
   ================================================================ */

import { h, Fragment } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'

const html = htm.bind(h)

const CLOSE_ICON_HTML = /*html*/ `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`

export function HeaderStats({
  totalTabs,
  visibleTabs,
  totalWindows,
  visibleWindows,
  totalDomains,
  visibleDomains,
  dedupCount,
  filteredCloseCount,
  hasCards,
  filtering
}) {
  const tabsLabel = filtering ? `${visibleTabs} of ${totalTabs} Open tab${totalTabs !== 1 ? 's' : ''}` : `${totalTabs} Open tab${totalTabs !== 1 ? 's' : ''}`

  const windowsLabel =
    visibleWindows === totalWindows
      ? `Across ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`
      : `Across ${visibleWindows} of ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`

  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} domain${totalDomains !== 1 ? 's' : ''}` : `${visibleDomains} of ${totalDomains} domain${totalDomains !== 1 ? 's' : ''}`

  const dedupTitle = `Close ${dedupCount} duplicate${dedupCount !== 1 ? 's' : ''}`

  // close-filtered button carries the close SVG inline; rendered via
  // dangerouslySetInnerHTML so the SVG keeps its own namespace handling
  // without us having to port it to preact h() calls.
  const closeFilteredButtonHtml = `${CLOSE_ICON_HTML} Close ${filteredCloseCount} filtered tab${filteredCloseCount !== 1 ? 's' : ''}`

  return html`
    <${Fragment}>
      <span id="openTabsDedupAction">
        ${dedupCount > 0 &&
        html`<button class="action-btn" data-action="dedup-global-keep-one" title=${dedupTitle} style="font-size:11px;padding:4px 12px;">Dedupe ${dedupCount}</button>`}
      </span>
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
      <span class="section-actions" id="openTabsSectionActions">
        ${filteredCloseCount > 0 &&
        html`<button
          class="action-btn close-tabs"
          data-action="close-filtered-tabs"
          style="font-size:11px;padding:4px 12px;"
          dangerouslySetInnerHTML=${{ __html: closeFilteredButtonHtml }}
        />`}
      </span>
    </${Fragment}>
  `
}
