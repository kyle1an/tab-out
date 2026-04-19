/* ================================================================
   <FlatSection> — Phase 3–5 of the Preact + HTM migration.

   Renders the "flat" block inside a subdomain section: the singletons
   (tabs whose path-group label was below the ≥2 cluster threshold).
   Visible chips are always in the DOM; hidden chips sit inside a
   `.page-chips-overflow` wrapper that's `display: none` by default and
   `display: contents` when expanded (CSS rules in base.css).
   filter.js flips the inline style on that wrapper when filter is
   active so its chip-search can reach hidden chips too — that's why
   we keep the .page-chips-overflow wrapper instead of conditionally
   omitting hidden chips from the DOM.

   Phase 5 replaced the dangerouslySetInnerHTML chip blocks with
   <PageChip> components. The chip-data arrays (visibleChips /
   hiddenChips) come pre-computed from buildChipData() in render.js.
   ================================================================ */

import { h } from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';
import { useState } from '../vendor/preact-hooks.mjs';
import { packMissionsMasonry } from '../layout.js';
import { PageChip } from './PageChip.js';

const html = htm.bind(h);

export function FlatSection({ visibleChips, hiddenChips, hiddenCount }) {
  const [expanded, setExpanded] = useState(false);

  function onExpand() {
    setExpanded(true);
    // Card heights change when hidden chips become visible; re-pack
    // masonry after the DOM settles so column bottoms realign.
    requestAnimationFrame(() => packMissionsMasonry());
  }

  return html/* html */`
    <div class="flat-section" data-expanded=${expanded ? 'true' : null}>
      ${visibleChips.map(chip => html/* html */`
        <${PageChip} key=${chip.rawUrl} chip=${chip} />
      `)}
      ${hiddenCount > 0 && html/* html */`
        <div class="page-chips-overflow">
          ${hiddenChips.map(chip => html/* html */`
            <${PageChip} key=${chip.rawUrl} chip=${chip} />
          `)}
        </div>
      `}
      ${!expanded && hiddenCount > 0 && html/* html */`
        <div class="page-chip page-chip-overflow clickable" onClick=${onExpand}>
          <span class="chip-text">+${hiddenCount} more</span>
        </div>
      `}
    </div>
  `;
}
