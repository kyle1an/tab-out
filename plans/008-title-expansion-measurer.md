# 008 — Finish the Title Expansion convergence: one measurer, three slices

- **Status**: INVESTIGATED 2026-07-13 — convergence REJECTED on contact; recommend retiring via ADR
- **Finding**: The premise ("the capture engine still lives twice") did not survive implementation contact. The shared engine already sits behind the seam — `createExpansionMeasureElement`, `searchExpandedWidth`, and the line-capture family ARE the deep shared implementation. What each surface hand-writes is per-surface measurement *policy* that differs on nearly every axis: PageChip has title-variant early paths, hydrating-pill natural-width paths, constrained-packed-width fallbacks, and a marker-wrap fits check; Activation History rows have their own fixed-line overflow predicate, a different line-height source, and an expanded-layout cache keyed on innerHTML+rect. The deletion test fails: deleting either engine would not re-materialize the other. A `createTitleExpansionMeasurer(config)` would need a config as wide as the code it hides (markup builder + fits predicate + guard policy + early-exit paths + caching) — a shallow module. The correct architecture is what the code already is: deep shared primitives, thin per-surface policy — the same split the Browser Tabs Gateway (005) and move-animation module (006) established. The module header's "until those converge behind this seam" caveat should be revised to name the primitives as the sanctioned interface for capture policy.
- **Commit**: 65a90ab
- **Strength**: Worth exploring (architecture review 2026-07-12, candidate 3; the module's own header sanctions this)
- **Category**: in-process
- **Estimated scope**: title-expansion module + PageChip + TabHistoryPanel, 2-3 commits

## Problem

The Title Expansion seam landed, but its interface is 14 value exports (`src/components/title-expansion/index.ts`) and both hover-expandable surfaces still hand-compose the capture engine from primitives: `PageChip.tsx:29` imports 14 symbols (engine ~`:570-660`, plus marker hydration `hydrateClonedExpandedChipFragment` at `:357`), `TabHistoryPanel.tsx:26` imports 13 (engine ~`:230-260`). The index's own header says the capture primitives are exported "until those converge behind this seam." Every engine change lands on two surfaces. WorkingSetPanel already consumes only the 3-symbol clamp/fade slice — the sliced-interface model works.

## Target (grilled decisions)

1. **`createTitleExpansionMeasurer(config)`** — per-surface configured instance (mirrors `createMoveAnimator`, plan 006). Config carries the surface's adapter knowledge: `hydrateFragment` callback (PageChip's filter-highlight/suppression markers), line classes (`ExpansionLineClasses`), width tolerances/constraints. Returns `measure(titleEl) → { expandedWidth, lines, … }` (exact result shape discovered from the two engines' common output).
2. **Primitives become internal seams**: `searchExpandedWidth`, `createExpansionMeasureElement`, and the line-capture family stop being exported from `index.ts`; they remain directly unit-tested inside the module.
3. **`index.ts` shrinks to ~7 value exports**: controller slice (`createTitleExpansionController`, `createTitleExpansionLane`, `useTitleExpansionController`), the measurer, and the clamp/fade slice (`clampedTitleLineNodes`, `captureVisibleLineHtml`, `syncTruncatedTitleFadeEnd`, `unwrapClampedTitleLines` — keep exactly what WorkingSetPanel + surfaces need at rest).
4. **Migration order**: TabHistoryPanel first (simpler engine shapes the config), PageChip second (adds the hydration callback), then delete the primitive exports and update the module header (the "until those converge" caveat comes out).
5. **The barrel stays the seam.** react-doctor's `no-barrel-import` warnings on these imports are tolerated (contract wins; warnings don't gate at `failOn: "error"`). No suppression comments.

## Boundaries

- Do NOT change expansion behavior, tolerances, or the controller/lane half — this narrows the interface, it does not retune.
- Do NOT touch WorkingSetPanel (already on the correct slice).
- Do NOT start this before plans 005-007 have landed (cooling is part of the decision).
- The build-pipeline test pins on tooltip/page-chip transition-none behavior (`tests/build-pipeline.test.ts:370`) are unrelated — leave them.

## Verification

- `pnpm verify` green per commit; build + dist staged.
- Feel check (unpacked extension): hover-expand a truncated Page Chip title and an Activation History row title — identical expansion, markers/highlights intact in expanded content; Working Set rows still clamp+fade.
- **Done when**: both surfaces import only sanctioned slices, `index.ts` exports no capture primitives, the header caveat is gone, and each surface's import list is ≤7 symbols.
