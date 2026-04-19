/* ================================================================
   <Missions> — Preact root for the card grid (Phase 1 of Preact
   migration, see ~/.claude/plans/pure-skipping-blanket.md).

   Owns #openTabsMissions. Renders one <DomainCardShell> per domain
   group. <DomainCardShell> is transitional: it uses
   `dangerouslySetInnerHTML` to inject the existing template-string
   output from renderDomainCard() in render.js. This keeps every
   inner level (subdomain sections, pathgroup sections, chips)
   working with the pre-Preact code path during Phase 1. Later
   phases progressively replace the inner HTML with real Preact
   components.

   The wrapper element carries `class="preact-card-mount"` and is
   styled `display: contents` in base.css so it's invisible in
   layout — the real `.mission-card` inside (from the template
   string) participates directly in the parent's grid/absolute
   positioning as if the wrapper weren't there.

   Key prop: each shell uses the stableId scheme that the old
   render.js already relies on. Preact's reconciliation matches by
   key across renders, so the wrapper div is preserved — along with
   any external mutations (like data-masonry-col set by layout.js).
   ================================================================ */

import { h, Fragment } from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';
import { renderDomainCard } from '../render.js';

const html = htm.bind(h);

function stableKey(group) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
}

function DomainCardShell({ group }) {
  return html/* html */`
    <div class="preact-card-mount"
         dangerouslySetInnerHTML=${{ __html: renderDomainCard(group) }}>
    </div>
  `;
}

export function Missions({ domains }) {
  return html/* html */`
    <${Fragment}>
      ${domains.map(g => html/* html */`
        <${DomainCardShell} key=${stableKey(g)} group=${g} />
      `)}
    </${Fragment}>
  `;
}
