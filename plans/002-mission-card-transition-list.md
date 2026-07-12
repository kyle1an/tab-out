# 002 — Fix the mission-card transition list to match what actually changes

- **Status**: DONE (commit `038fd4f`)
- **Commit**: 14757f3
- **Severity**: MEDIUM
- **Category**: Easing & duration / intent mismatch
- **Estimated scope**: 1 file, 1 single-line class edit

## Problem

The card surface declares `transition-[box-shadow,transform]`, but nothing ever sets `transform` on `.mission-card` — the FLIP move animation translates the parent `.domain-block` instead (`src/extension/layout.ts:9–12` documents that the block, not the inner card, is the masonry/move unit). Meanwhile the states that DO change on this element mutate **border-color**, which is not in the list and therefore snaps:

- the cross-surface hover-match frame (hovering a working-set/history row highlights the matching card) — scanning rows makes the card frame flick on/off with zero easing;
- the pinned-domain drag-reorder feedback (source card border tint + shadow lift, target/noop border tints).

The one property in the list that does change — the drag-pickup `box-shadow` — eases in over a sluggish 250ms on the weak built-in `ease`, so grabbing a card acknowledges the grab noticeably late.

Current code:

```tsx
// src/components/DomainCard.tsx:512 — current
'mission-card relative flex flex-col gap-2 overflow-visible rounded-[22px] border border-(--warm-gray) bg-tab-card transition-[box-shadow,transform] duration-250 ease-[ease] [corner-shape:squircle]',
```

The states that change it (context only — do not edit these lines):

```tsx
// src/components/DomainCard.tsx:516 — hover-match frame (border-color)
'group-has-[.page-chip.page-chip-hover-match]/domain-block:border-[color-mix(in_srgb,var(--accent-amber)_42%,var(--warm-gray))] ...',
// src/components/DomainCard.tsx:517 — drag reorder source/target (border-color + box-shadow)
'group-data-[tabout-reorder-source=true]/domain-block:border-[...] group-data-[tabout-reorder-source=true]/domain-block:shadow-[0_4px_12px_rgba(10,10,10,0.08)] ...',
```

## Target

```tsx
// src/components/DomainCard.tsx:512 — target
'mission-card relative flex flex-col gap-2 overflow-visible rounded-[22px] border border-(--warm-gray) bg-tab-card transition-[box-shadow,border-color] duration-150 ease-swift [corner-shape:squircle]',
```

- `transform` dropped (dead entry), `border-color` added (the property that actually changes).
- 250ms → **150ms** — border/shadow feedback on hover and grab should acknowledge fast.
- Weak `ease` → the `ease-swift` token (`cubic-bezier(0.2, 0, 0, 1)`), defined by plan 001 in `src/styles/app.css`. **If plan 001 has not been applied yet**, use `ease-[cubic-bezier(0.2,0,0,1)]` instead of `ease-swift` and note it for later token migration.

## Repo conventions to follow

- Motion tokens live in the `@theme` block of `src/styles/app.css`; the house curve is `cubic-bezier(0.2, 0, 0, 1)` (see `src/extension/working-set-move-animation.ts:151` for the canonical usage).
- Class edits happen inside the `cn(...)` call's quoted strings in `DomainCard.tsx`; keep every other utility in the string untouched and in order.
- Commits: conventional-commit format, with the repo's `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

## Steps

1. **`src/components/DomainCard.tsx:512`** — replace the segment
   `transition-[box-shadow,transform] duration-250 ease-[ease]` with
   `transition-[box-shadow,border-color] duration-150 ease-swift`.
2. Run `pnpm build` and stage `extension/dist` together with the source edit.

## Boundaries

- Do NOT touch lines 516–519 (the border-color/shadow *values*) — only the transition declaration on line 512 changes.
- Do NOT add a transition to `.domain-block` (line 455) — the FLIP animator owns its transitions and `tests/layout.test.ts:59` pins that string.
- Do NOT add any new border or outline to chips or cards — this plan only makes an existing border-color change ease instead of snap.
- No new dependencies. If line 512 no longer matches the excerpt above (drift since commit 14757f3), STOP and report.

## Verification

- **Mechanical**: `pnpm verify` passes. `tests/layout.test.ts:61` asserts the built CSS has no `top|left|width` transitions on `.domain-block` rules — unaffected by this edit, but confirm it still passes.
- **Feel check**: load the unpacked `extension/` in Chrome (or `pnpm serve` → `extension/index.html`) with the history panel open:
  - Sweep the pointer up and down the history/working-set rows: matching card frames should now fade in/out over ~150ms instead of flickering on/off. At DevTools Animations 10% speed, the border tint eases both directions (transitions retarget mid-flight — rapid sweeps must never restart from zero or lag behind the pointer by more than the 150ms tail).
  - Grab a pinned domain's reorder handle: the shadow lift and border tint should land almost immediately (fast-start curve) rather than drifting in.
  - Confirm cards still glide smoothly when the masonry repacks (the FLIP path is untouched).
- **Done when**: hover-match and drag feedback visibly ease at ~150ms, no transform transition remains on `.mission-card`, and `pnpm verify` is green with dist staged.
