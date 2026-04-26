/* ================================================================
   <Missions> — Preact root for the card grid.

   Owns #openTabsMissions. Renders one <DomainCard> per domain group.
   All nested layers (card chrome, subdomain sections, pathgroup
   clusters, flat singletons, individual chips) are Preact
   components; there is no remaining dangerouslySetInnerHTML in the
   post-migration component tree.

   Key prop: uses the stableId scheme already proven in render.js so
   Preact's reconciliation matches cards across live-sync rebuilds
   — the `.domain-block` DOM node is preserved between renders, and
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

function EmptyState({ source = 'tabs' }) {
  const noun = source === 'bookmarks' ? 'bookmarks' : source === 'history' ? 'history results' : 'tabs'
  return html`
    <div class="missions-empty-state">
      <div class="empty-title">No ${noun}.</div>
    </div>
  `
}

function NoResultsState({ query = '' }) {
  return html`
    <div class="missions-empty-state missions-empty-state-filter">
      <div class="empty-title">${query ? `No matches for “${query}”.` : 'No matches.'}</div>
    </div>
  `
}

export function Missions({ cards, filter = '', source = 'tabs', showEmptyState = true, onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }) {
  if (!cards || cards.length === 0) {
    if (!showEmptyState) return null
    return filter ? html`<${NoResultsState} query=${filter} />` : html`<${EmptyState} source=${source} />`
  }
  return html`
    <${Fragment}>
      ${cards.map(
        ({ group, vm }) =>
          html` <${DomainCard}
            key=${stableKey(group)}
            group=${group}
            vm=${vm}
            filter=${filter}
            onHoverUrlChange=${onHoverUrlChange}
            onLayoutChange=${onLayoutChange}
            onTogglePinnedDomain=${onTogglePinnedDomain}
          /> `
      )}
    </${Fragment}>
  `
}
