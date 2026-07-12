# 004 — Put the source-switch indicator on the house curve

- **Status**: DONE (commit `9fa5606`)
- **Commit**: 14757f3
- **Severity**: MEDIUM
- **Category**: Easing & duration / cohesion
- **Estimated scope**: 2 files (1 class edit + 1 test-pin update)

## Problem

The sliding indicator behind the Tabs / Bookmarks / History source switch — a control used many times a day — animates with the weak built-in `ease-in-out`, while every other deliberate movement in the app (card FLIP, working-set FLIP, chip close) rides `cubic-bezier(0.2, 0, 0, 1)`. The built-in curve makes the slide feel mushy next to them.

Current code:

```tsx
// src/components/HeaderBar.tsx:69 — current
<TabsPrimitive.Indicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-(--active-tab-width) rounded-[calc(var(--header-control-radius)_-_6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] [transform:translateX(var(--active-tab-left))_translateY(-50%)] [transition:width_0.2s_ease-in-out,transform_0.2s_ease-in-out]" />
```

This exact string is pinned by a regression test:

```ts
// tests/layout.test.ts:258–262 — current
test('source switch indicator keeps transform-based transition', () => {
  ...
  assert.match(source, /\[transition:width_0\.2s_ease-in-out,transform_0\.2s_ease-in-out\]/)
```

Note: animating `width` is deliberate here and stays. The indicator is a squircle (`corner-shape:squircle` + radius); animating `scaleX` instead would distort its corners while moving. It is a single small element with no children, so the per-frame layout cost is negligible.

## Target

Same 200ms, same width+transform pair, strong curve via the `ease-swift` token (defined by plan 001 as `--ease-swift: cubic-bezier(0.2, 0, 0, 1)` in `src/styles/app.css`):

```tsx
// src/components/HeaderBar.tsx:69 — target (only the transition segment changes)
{/* Animates width (not scaleX): scaling would distort the squircle corners mid-slide. */}
<TabsPrimitive.Indicator className="source-switch-indicator ... [transform:translateX(var(--active-tab-left))_translateY(-50%)] transition-[width,transform] duration-200 ease-swift" />
```

**If plan 001 has not been applied yet**, use `ease-[cubic-bezier(0.2,0,0,1)]` in place of `ease-swift` (and mirror that in the test regex).

## Repo conventions to follow

- The house movement curve `cubic-bezier(0.2, 0, 0, 1)` — exemplar: `src/extension/working-set-move-animation.ts:151`.
- Source-pinning tests in `tests/layout.test.ts` guard motion regressions by matching class strings; when a guarded string changes intentionally, update the pin to the new string while preserving the test's intent (here: the indicator must keep a width/transform transition, never `top`/`left`).
- Commits: conventional-commit format, with the repo's `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

## Steps

1. **`src/components/HeaderBar.tsx:69`** — replace the segment
   `[transition:width_0.2s_ease-in-out,transform_0.2s_ease-in-out]` with
   `transition-[width,transform] duration-200 ease-swift`.
   Add the one-line comment from the Target section directly above the `<TabsPrimitive.Indicator` element (it states a constraint the code can't show: why `width`, not `scaleX`).
2. **`tests/layout.test.ts:262`** — update the pinned regex to the new string:

   ```ts
   assert.match(source, /transition-\[width,transform\] duration-200 ease-swift/)
   ```

   Keep the test name and any sibling assertions unchanged.
3. Run `pnpm build` and stage `extension/dist` together with the source edits.

## Boundaries

- Do NOT change the duration (200ms is right for a 100–200px slide) or the animated property pair.
- Do NOT touch the sibling `TabsTrigger` styling in `HeaderBar.tsx` or `ui/tabs.tsx` (plan 003's scope).
- Do NOT add `motion-reduce` handling here (tracked separately as audit finding #6 — reduced-motion sweep).
- No new dependencies. If the quoted segments don't match (drift since commit 14757f3), STOP and report.

## Verification

- **Mechanical**: `pnpm verify` passes, including the updated `tests/layout.test.ts` pin.
- **Feel check**: load the unpacked `extension/` in Chrome (or `pnpm serve` → `extension/index.html`):
  - Click between Tabs / Bookmarks / History: the pill should launch immediately and settle softly (fast-out) instead of easing in and out symmetrically.
  - Click a far option mid-slide: the transition retargets from its current position (CSS transitions do this natively — confirm no restart-from-zero).
  - DevTools Animations at 10%: width and position stay in lockstep while the pill both moves and resizes (e.g. between a wide and a narrow option label).
- **Done when**: the indicator uses `duration-200 ease-swift` with the width rationale comment in place, the test pin matches the new string, `pnpm verify` green, dist staged.
