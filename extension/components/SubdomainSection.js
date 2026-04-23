/* ================================================================
   <SubdomainSection> — Phase 3 of the Preact + HTM migration
   (extended in Phase 4 to render <PathgroupSection> children).

   Renders one subdomain section inside a card: an optional
   subdomain header, then the flat singletons (via <FlatSection>),
   then cluster sub-sections (via <PathgroupSection>).

   Stable key on the outer .subdomain-section div (via the parent's
   list-render key) means Preact reuses the same DOM node across
   live-sync re-renders, and child components' local useState
   (FlatSection's expand, PathgroupSection's expand) survive with it.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { closeTabsExact } from '../tabs.js'
import { requestDashboardRefresh } from '../dashboard-controller.js'
import { markClosure } from '../undo.js'
import { FlatSection } from './FlatSection.js'
import { PathgroupSection } from './PathgroupSection.js'

const html = htm.bind(h)

function SubdomainCloseButton({ count, onClick }) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return html`
    <button class="subdomain-close-btn" title=${title} onClick=${onClick}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `
}

export function SubdomainSection({
  subdomainKey,
  isShared,
  isPort,
  sectionCount,
  sectionClosableUrls,
  showHeader,
  hasFlat,
  flatVisibleChips,
  flatHiddenChips,
  flatHiddenCount,
  clusters,
  onHoverUrlChange = null,
  onLayoutChange = null
}) {
  const hasClose = showHeader && sectionClosableUrls && sectionClosableUrls.length > 0
  // Shared folded chips render without a section header now. When a
  // header is present, it is always a literal subdomain label; the
  // trailing "." suffix (FQDN-style hostname cue) is added via CSS
  // `::after` so it can render muted/thinner than the name itself
  // (see style.css).
  const headerLabel = subdomainKey

  // Close-subdomain handler. Mirrors PathgroupSection's cluster close
  // — exact-URL match + preserveGroups so Chrome tab groups survive.
  // Only wired when `showHeader` is true (multi-subdomain cards), so
  // single-subdomain cards still rely on the card-level close button.
  async function onCloseSubdomain() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    const snapshot = await closeTabsExact(sectionClosableUrls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    }
    await requestDashboardRefresh()
  }

  return html`
    <div class="subdomain-section" data-shared=${isShared ? 'true' : null} data-kind=${isPort ? 'port' : null}>
      ${showHeader &&
      html`
        <div class="subdomain-header">
          <span class="subdomain-header-name">${headerLabel}</span>
          <span class="subdomain-header-count">${sectionCount}</span>
          ${hasClose && html` <${SubdomainCloseButton} count=${sectionClosableUrls.length} onClick=${onCloseSubdomain} /> `}
        </div>
      `}
      ${hasFlat &&
      html`
        <${FlatSection}
          visibleChips=${flatVisibleChips}
          hiddenChips=${flatHiddenChips}
          hiddenCount=${flatHiddenCount}
          onHoverUrlChange=${onHoverUrlChange}
          onLayoutChange=${onLayoutChange}
        />
      `}
      ${clusters.map(
        (c) => html`
          <${PathgroupSection}
            key=${c.key}
            label=${c.label}
            isPR=${c.isPR}
            count=${c.count}
            closableUrls=${c.closableUrls}
            visibleChips=${c.visibleChips}
            hiddenChips=${c.hiddenChips}
            hiddenCount=${c.hiddenCount}
            onHoverUrlChange=${onHoverUrlChange}
            onLayoutChange=${onLayoutChange}
          />
        `
      )}
    </div>
  `
}
