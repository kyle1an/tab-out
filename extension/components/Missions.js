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

export function Missions({ domains }) {
  return html`
    <${Fragment}>
      ${domains.map((g) => html` <${DomainCard} key=${stableKey(g)} group=${g} /> `)}
    </${Fragment}>
  `
}
