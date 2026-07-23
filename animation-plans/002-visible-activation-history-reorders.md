# 002 — Animate observable Activation History reorders

- **Status**: DONE
- **Supersedes**: [001 — Animate only visible pointer-driven Activation History reorders](001-pointer-only-activation-history-reorder.md)
- **Severity**: LOW
- **Category**: Missed opportunities / purpose and frequency

## Problem

Plan 001 tied the row FLIP to a primary-pointer focus request whose exact
snapshot committed before Tab Out became hidden. That was safe but so narrow
that a normal same-window click almost never showed the motion. It also left
keyboard, modifier, passive browser, visible hydration, and return-from-hidden
reorders as abrupt shifts even when the user could see the panel or its final
state.

Window focus is not the right observability boundary. A Tab Out window can be
unfocused and still visible beside another window. The browser's page
visibility state is the useful gate: animate when the document can be painted,
and retain last-visible geometry while it cannot.

## Target behavior

- Keep one last-visible geometry snapshot for the currently mounted Activation
  History content root, its filter, and its measured width.
- After any committed row-array change while `document.visibilityState` is
  `visible`, FLIP stable surviving rows from that snapshot to their new DOM
  positions. Do not inspect focus or input provenance.
- If rows commit while the document is hidden, preserve the last-visible
  snapshot. When the same mounted panel becomes visible, FLIP once from the
  last geometry the user could have seen to the current order.
- Animate visible keyboard, pointer, modifier, passive browser refresh, and
  cached-to-live row reorders. Tab focus and snapshot fetching remain
  independent of motion and are never delayed.
- Reuse `historyEntryMoveAnimator`: transform only, `180ms`,
  `var(--ease-swift)`, root-relative positions, and stable layout keys. New or
  removed rows have no matching old rectangle and therefore settle directly.
- Preserve interruption continuity. If a new layout commits during an active
  FLIP, capture the current visual rectangles, clear the old transform, retain
  the new logical baseline, and start the replacement FLIP from what was on
  screen.
- After the existing close or forget removal motion settles, refresh the
  last-visible baseline before its React data refresh so survivor movement is
  not replayed.

## Intentional non-triggers

- `prefers-reduced-motion: reduce`.
- True first paint, because no previously painted row geometry exists.
- Filter changes or source replacement, because the visible collection changed
  context rather than merely changing order.
- A materially changed Activation History content width, because stale
  coordinates can reflect reflow instead of reorder motion.
- Rows that are newly inserted, removed, or otherwise lack a stable surviving
  layout key.
- Commits with no stable row movement of at least one pixel.
- The React refresh immediately following a close or forget animation, because
  that user-visible movement already ran through the same FLIP adapter.

Hidden commits are not permanent non-triggers. They defer until the same panel
becomes visible. An unfocused but visible window still animates.

## Implementation

1. Keep the stable stack-row layout key from plan 001 while retaining the
   index-bearing React render key.
2. Replace pointer-request bookkeeping with a `VisibleHistoryLayoutSnapshot`
   owned by `TabHistoryPanel`.
3. Synchronize that snapshot in a layout effect after title measurement and on
   `visibilitychange` when returning to visible.
4. Guard reuse by content-root identity, filter identity, and panel width.
5. Let close and forget report their settled post-removal geometry before
   applying their data refresh.
6. Record this visibility-first policy in `CONTEXT.md` and regenerate the
   extension bundle from source.

## Verification

- Unit-test stable stack layout identity and the shared three-row FLIP adapter.
- Browser-test first paint, pointer, Enter, Space, modifier, passive refresh,
  an unfocused-visible document, hidden-then-visible replay, width invalidation,
  reduced motion, cleanup, duration/easing, and focus-before-motion ordering.
- Run typecheck, lint, React Doctor, compiler baseline, build, unit tests, the
  browser layout suite, and focused extension smoke where practical.

## Done when

- Any stable reorder that might be visible gets one interruptible survivor
  FLIP, regardless of input method or window focus.
- Hidden reorders defer and animate once on return without stale-width or
  cross-filter movement.
- First paint, reduced motion, unmatched rows, and already-animated removal
  refreshes remain still.
- Generated output comes from the source build and verification either passes
  or has a precise unrelated blocker recorded here.

## Verification result

- Passed `pnpm verify:quick`: typecheck, lint, React Doctor, and the React
  Compiler baseline.
- `pnpm build` succeeded twice with an unchanged `extension/dist/app.js` hash.
- Passed all 1,001 unit tests and all 60 browser-layout tests, including the
  revised Activation History trigger and guard cases.
- Passed the focused close-removal layout test and the focused extension smoke
  for Activation History scrollbar cancellation.
- `pnpm verify` reaches `verify:bundle` and reports the expected generated
  bundle diff because the pre-existing plan-001 index is intentionally
  preserved while this revision remains unstaged. The build and the remaining
  unit phase were run and verified separately without changing the index.
- Real-Chrome multi-window feel inspection remains manual; the browser fixture
  directly covers visible-but-unfocused behavior and hidden-to-visible replay.
