/* ================================================================
   <Missions> — Preact root for the card grid.

   Owns #openTabsMissions. Renders one <DomainCard> per domain group.
   All nested layers (card chrome, subdomain sections, pathgroup
   clusters, flat singletons, individual chips) are Preact
   components; there is no remaining dangerouslySetInnerHTML in the
   post-migration component tree.

   Key prop: uses the stableId scheme already proven in render.js so
   Preact's reconciliation matches cards across live-sync rebuilds
   — the `.mission-card` DOM node is preserved between renders, and
   external mutations like data-masonry-col (set by layout.js) ride
   along unchanged. Component-local useState inside descendant
   <FlatSection>s and <PathgroupSection>s also survives, replacing
   the previous prevExpanded DOM snapshot/restore.
   ================================================================ */

import { h, Fragment } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { DomainCard } from './DomainCard.js'

const html = htm.bind(h)

function stableKey(group) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

// "Inbox zero" empty state — rendered when the card list is empty.
// Previously this lived in ui.js:checkAndShowEmptyState, which
// injected innerHTML into a Preact root (racy with the next
// live-sync render, which would throw on the stale reconciler
// state). Now it's just another branch of Missions — Preact
// reconciles it correctly and swaps back to the card list as soon
// as there's a domain to render.
function EmptyState() {
  return html`
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `
}

export function Missions({ domains }) {
  if (!domains || domains.length === 0) return html`<${EmptyState} />`
  return html`
    <${Fragment}>
      ${domains.map((g) => html` <${DomainCard} key=${stableKey(g)} group=${g} /> `)}
    </${Fragment}>
  `
}
