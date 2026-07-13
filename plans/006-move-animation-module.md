# 006 — One FLIP move module behind one seam

- **Status**: TODO
- **Commit**: 65a90ab
- **Strength**: Worth exploring (architecture review 2026-07-12, candidate 2 — new, friction observed during the motion-token work)
- **Category**: in-process
- **Estimated scope**: 1 new module replaces 2 (~330 lines → ~200 + 2 adapter configs), 1-2 commits

## Problem

The FLIP lifecycle (snapshot → invert → forced reflow → rAF play → transitionend/timeout cleanup → reduced-motion gate → interaction-state suppression) is implemented twice: `src/extension/card-move-animation.ts` (170 lines) and `src/extension/working-set-move-animation.ts` (157 lines). They have already drifted: cards play via a test-pinned CSS class (`tests/layout.test.ts:59` pins the arbitrary-variant transition in `DomainCard.tsx:455`), working-set plays via a test-pinned inline literal (`tests/working-set.test.ts:515`); one `shouldReduceMotion` has a `window` guard, the other doesn't. The 2026-07-12 motion-token commit had to leave "keep in sync" comments in `src/styles/app.css` because no single module owns the recipe.

## Target (grilled decisions)

1. **Module-owned inline transition** on the motion token: the module writes `transform ${duration}ms var(--ease-swift)` inline. `DomainCard.tsx:455`'s `[.missions.is-packed_&.layout-moving…]` transition + motion-reduce arbitrary variants retire (the JS gate covers reduced motion; consumer styling like z-lift stays on the marker classes it already uses).
2. **Interface**: `createMoveAnimator(config) → { snapshot(root|roots), animate(root|roots, previous), cancel(root|roots) }` in `src/extension/move-animation.ts`. Config: `itemSelector`, `keyOf(el)`, `duration`, marker class names, optional `beforePlay(roots)` (card scroll-region bleed) and `afterCleanup(el)` (working-set settle + toggle hover-suppression). Behavior is the general case both fit: **container-relative measurement** and **multi-position closest-match keying** (duplicate domain ids across mission containers — `card-move-animation.ts:74-94` is the reference implementation).
3. **Consumers become adapters**: `card-move-animation.ts` and `working-set-move-animation.ts` shrink to configured instances (or their call sites configure directly) — Domain Card blocks · 280ms · bleed; Working Set items · 220ms · settle. Public function names consumed by `App.tsx`/`WorkingSetPanel.tsx` may stay as thin re-exports to bound the diff.
4. **Naming: code-only.** No CONTEXT.md change (mechanism, not domain language; the glossary's Domain Card Identity line already references card move animation DOM hooks, which don't change).
5. **Tests re-anchor**: one behavioral suite (`tests/move-animation.test.ts`) driven by structural fakes — the `PageChipCloseAnimation.ts:6-24` structural-typing idiom. Cover: multi-position closest-match, <1px move skip, interruption/cancel idempotency, transitionend-vs-timeout cleanup, reduced-motion skip, hook invocation. Replace the two source pins: `tests/layout.test.ts:58-62` re-anchors (keep line 61's built-CSS "no top/left/width transitions" guard), `tests/working-set.test.ts:515` and `:482`/`:520` re-anchor to the module.

## Boundaries

- Do NOT change `PageChipCloseAnimation.ts` (different shape: ghost + collapse, already deep).
- Do NOT change durations (280/220), the curve, or the bleed/settle behaviors — this is consolidation, not retuning.
- Do NOT add a CONTEXT.md entry.
- Update the `--ease-swift` comment in `src/styles/app.css` (it names the two animators as literal-pinning; after this, the inline recipe reads the token — reword to name `move-animation.ts` and the FLIP tests).

## Verification

- `pnpm verify` green; build + dist staged.
- Feel check (unpacked extension): close a tab so cards repack — identical glide; pin/unpin a working-set item — identical slide + settle; toggle reduced motion — both skip.
- **Done when**: one module owns the lifecycle; both consumers are config; the curve literal appears nowhere in TS; the old per-twin pins are gone and the behavioral suite passes.
