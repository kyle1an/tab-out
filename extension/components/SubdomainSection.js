/* ================================================================
   <SubdomainSection> — Phase 3 of the Preact + HTM migration.

   Renders one subdomain section inside a card: an optional subdomain
   header, then the flat singletons (via <FlatSection>), then cluster
   sub-sections (still template-string HTML from render.js — Phase 4
   migrates those to <PathgroupSection>).

   Stable key on the outer .subdomain-section div (via the parent's
   list-render key) means Preact reuses the same DOM node across
   live-sync re-renders, and FlatSection's local useState survives
   with it.
   ================================================================ */

import { h } from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';
import { FlatSection } from './FlatSection.js';

const html = htm.bind(h);

export function SubdomainSection({
  subdomainKey,
  sectionCount,
  showHeader,
  hasFlat,
  flatVisibleChipsHtml,
  flatHiddenChipsHtml,
  flatHiddenCount,
  clusterHtml,
}) {
  const dataKey = subdomainKey || '__root__';

  return html/* html */`
    <div class="subdomain-section" data-subdomain-key=${dataKey}>
      ${showHeader && html/* html */`
        <div class="subdomain-header">
          <span class="subdomain-header-name">${subdomainKey}</span>
          <span class="subdomain-header-count">${sectionCount}</span>
        </div>
      `}
      ${hasFlat && html/* html */`
        <${FlatSection}
          visibleChipsHtml=${flatVisibleChipsHtml}
          hiddenChipsHtml=${flatHiddenChipsHtml}
          hiddenCount=${flatHiddenCount} />
      `}
      ${clusterHtml && html/* html */`
        <div class="subdomain-cluster-mount"
             dangerouslySetInnerHTML=${{ __html: clusterHtml }}></div>
      `}
    </div>
  `;
}
