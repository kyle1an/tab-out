/* ================================================================
   Chip Trim — the module interface (CONTEXT.md: Chip Trim).

   The per-kind surface paint and seam participation of a Page Chip —
   active frames, group/saved-page interaction outlines, interaction
   fills, slot seam overlap, and interaction z-order — decided by one
   decision table. Consumers import from here only; files inside this
   directory are implementation.

   The contract, in full:

   • chipTrim(facts) → { chipClasses, iconChipClasses, slotClasses,
     frame, styleVars, expandedFill }. Facts in, paint out — kind
     resolution and precedence (an active frame suppresses the group
     outline) live INSIDE the table, never in callers.

   • A chip kind that draws no trim at rest never gains a border or
     outline from hover, context menu, or Title Expansion. Interaction
     feedback for trim-less kinds is fill-only, and their fills are
     translucent so a neighbour's line on the shared seam row shows
     through.

   • Adjacent full-width chip slots overlap by 1px so coinciding trim
     lines render once. Whoever paints on the shared row either draws
     a line there (frames, outlines) or lets the neighbour's line show
     through (translucent fills; the expanded fill layer spares edges
     flush with the resting seam).

   • The CSS rump (chip-trim.css) is part of this interface: exactly
     the rules that must stay CSS — the slot seam overlap (an
     adjacent-sibling rule) and everything keyed on :hover, which must
     swap inside one style recalculation (the hover-flash lesson,
     2026-06-13). Its selectors use only CHIP_TRIM_TOKENS names.
   ================================================================ */

export { chipTrim, CHIP_TRIM_TOKENS } from './trim'
export type { ChipTrim, ChipTrimFacts } from './trim'
