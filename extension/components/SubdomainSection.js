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
import { FlatSection } from './FlatSection.js'
import { PathgroupSection } from './PathgroupSection.js'

const html = htm.bind(h)

export function SubdomainSection({ subdomainKey, sectionCount, showHeader, hasFlat, flatVisibleChips, flatHiddenChips, flatHiddenCount, clusters }) {
  const dataKey = subdomainKey || '__root__'

  return html`
    <div class="subdomain-section" data-subdomain-key=${dataKey}>
      ${showHeader &&
      html`
        <div class="subdomain-header">
          <span class="subdomain-header-name">${subdomainKey}</span>
          <span class="subdomain-header-count">${sectionCount}</span>
        </div>
      `}
      ${hasFlat && html` <${FlatSection} visibleChips=${flatVisibleChips} hiddenChips=${flatHiddenChips} hiddenCount=${flatHiddenCount} /> `}
      ${clusters.map(
        (c) => html`
          <${PathgroupSection}
            key=${c.label}
            label=${c.label}
            count=${c.count}
            closableUrls=${c.closableUrls}
            visibleChips=${c.visibleChips}
            hiddenChips=${c.hiddenChips}
            hiddenCount=${c.hiddenCount}
          />
        `
      )}
    </div>
  `
}
