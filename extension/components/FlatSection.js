/* ================================================================
   <FlatSection> — Phase 3–5 of the Preact + HTM migration.

   Renders the "flat" block inside a subdomain section: the singletons
   (tabs whose path-group label was below the ≥2 cluster threshold).
   Visible chips are always in the DOM; hidden chips sit inside a
   `.page-chips-overflow` wrapper that's `display: none` by default and
   `display: contents` when expanded (CSS rules in base.css).
   Filtering now happens in the App/root VM before the chips arrive
   here, but we still keep the .page-chips-overflow wrapper so local
   expand state can reveal the hidden set in place.

   Phase 5 replaced the dangerouslySetInnerHTML chip blocks with
   <PageChip> components. The chip-data arrays (visibleChips /
   hiddenChips) come pre-computed from buildChipData() in render.js.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useState } from '../vendor/preact-hooks.mjs'
import { PageChip } from './PageChip.js'

const html = htm.bind(h)

export function FlatSection({ visibleChips, hiddenChips, hiddenCount, onHoverUrlChange = null, onLayoutChange = null }) {
  const [expanded, setExpanded] = useState(false)
  const iconOnly = visibleChips.length > 0 && visibleChips.every((chip) => chip.iconOnly)

  function onExpand() {
    setExpanded(true)
    // Card heights change when hidden chips become visible; re-pack
    // masonry after the DOM settles so column bottoms realign.
    if (onLayoutChange) onLayoutChange()
  }

  return html`
    <div class=${'flat-section' + (iconOnly ? ' flat-section-icons' : '')} data-expanded=${expanded ? 'true' : null}>
      ${visibleChips.map((chip) => html` <${PageChip} key=${chip.rawUrl} chip=${chip} onHoverUrlChange=${onHoverUrlChange} /> `)}
      ${hiddenCount > 0 &&
      html` <div class="page-chips-overflow">${hiddenChips.map((chip) => html` <${PageChip} key=${chip.rawUrl} chip=${chip} onHoverUrlChange=${onHoverUrlChange} /> `)}</div> `}
      ${!expanded &&
      hiddenCount > 0 &&
      html`
        <div class="page-chip page-chip-overflow clickable" onClick=${onExpand}>
          <span class="chip-text">+${hiddenCount} more</span>
        </div>
      `}
    </div>
  `
}
