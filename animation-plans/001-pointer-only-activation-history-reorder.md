# 001 — Animate only visible pointer-driven Activation History reorders

- **Status**: SUPERSEDED by [002 — Animate observable Activation History reorders](002-visible-activation-history-reorders.md)
- **Commit**: 0a1f9dab
- **Severity**: LOW
- **Category**: Missed opportunities / purpose and frequency
- **Estimated scope**: 6 authored files plus regenerated `extension/dist/app.js`; roughly 120–180 lines including tests

## Problem

Activation History already uses the shared FLIP mover when a visible close or
forget action removes a row. It does not bridge an ordinary position change
after the user points at a live history row and activates it:

```ts
/* src/extension/history-entry-move-animation.ts:1 — current */
/* ================================================================
   Activation History row move adapter

   Closing/forgetting a row removes it from layout immediately while
   the stable-key survivors FLIP into the gap. The fixed exit ghost is
   owned by LayoutRemovalAnimation.
   ================================================================ */

const HISTORY_ENTRY_MOVE_MS = 180
```

The focus path applies its fetched snapshot directly, and the same function is
used by both pointer and keyboard activation:

```ts
/* src/components/TabHistoryPanel.tsx:930 — current */
const result = await focusHistoryEntryResult(entry)
if (!focusChangedActiveTab(result)) return
onSnapshotChange?.(await fetchTabHistorySnapshot())

async function activateHistoryEntry(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
  const mode = chipActivationMode(e, navigator.platform)
  // ...
  if (mode === 'focus') {
    await onFocusEntry()
    return
  }
  // ...
}

function onEntryKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  // ...
  void activateHistoryEntry(e)
}
```

A generic “animate whenever `snapshot` changes” effect would be wrong. Tab
activation and page visibility both schedule passive refreshes, so it would
animate high-frequency keyboard navigation, startup/live reconciliation, and
changes that happened while Tab Out was hidden:

```ts
/* src/app.tsx:52 — current */
if (chrome.tabs) {
  chrome.tabs.onCreated.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onActivated.addListener(schedulePassiveDashboardRefresh)
  // ...
}

/* src/app.tsx:115 — current */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void settleDashboardRefresh(requestDashboardRefresh())
  }
})
```

There is also an identity mismatch for a true history reorder. The current key
contains the mutable history index, so a tab that is deduped and appended at a
new cursor position cannot be matched to its previous rectangle:

```ts
/* src/components/TabHistoryPanel.tsx:1693 — current */
function historyPanelRowLayoutKey(row: HistoryPanelRow): string {
  if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}:${row.entry.index}`
  if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
  return `closed-ghost:${row.closed.sessionId}`
}
```

## Target

Add one narrowly qualified FLIP lifecycle with these exact rules:

- Qualify only an unmodified primary pointer click on an existing `stack` row:
  the React event must have `type === 'click'`, `button === 0`, `detail > 0`,
  and no Alt/Ctrl/Meta/Shift modifier; `chipActivationMode(...)` must resolve to
  `focus`.
- Focus the Chrome tab immediately. Never wait for a frame or for the `180ms`
  animation before calling or resolving `focusHistoryEntryResult(entry)`.
- After focus succeeds and the next history snapshot is fetched, capture the
  current row rectangles only if `document.visibilityState === 'visible'` and
  immediately before passing that exact snapshot to `onSnapshotChange`.
- After React commits that exact snapshot object, and only while the document is
  still visible, FLIP stable surviving rows from their captured rectangles into
  their new positions.
- Use the existing `historyEntryMoveAnimator`: `transform` only, `180ms`,
  `var(--ease-swift)` (`cubic-bezier(0.2, 0, 0, 1)`), root-relative coordinates,
  and moving `z-index: 2`. Do not add opacity, blur, scale, spring, stagger, or a
  second easing/duration token.
- Keep the shared animator's interruption behavior: a newer snapshot cancels
  stale inline transform/transition ownership before measuring or starting the
  next move.
- Use a stable FLIP identity for stack rows,
  `stack:${windowId}:${tabId}`, while retaining the current React render key
  `stack:${windowId}:${tabId}:${index}`. The motion identity must survive index
  changes without changing existing component remount semantics.
- Newly inserted rows appear immediately in their final place. Only survivors
  with a previous rectangle move; deltas under `1px` remain skipped by the
  shared animator.
- Under `prefers-reduced-motion: reduce`, update the order immediately with no
  positional movement. The persistent current-row background/ring and marker
  emphasis remain the state feedback; do not add a replacement fade.

Explicit non-triggers:

- Enter or Space activation, programmatic/synthetic clicks with `detail === 0`,
  and extension keyboard shortcuts.
- Shift-click, Cmd/Ctrl-click, Cmd/Ctrl+Shift-click, Alt-click, middle-click,
  right-click, or context-menu actions.
- `open-ghost` Working Set rows and `closed-ghost` recently closed rows.
- Close/forget removal; those retain their existing independent exit-ghost and
  survivor-FLIP path.
- Startup/cache paint, live startup hydration, source/filter changes,
  `chrome.tabs.onActivated`, `chrome.windows.onFocusChanged`, and any other
  passive dashboard refresh.
- The `visibilitychange` refresh when the user returns to Tab Out.
- Any commit captured while visible but applied after the document becomes
  hidden, any failed focus/fetch, or any snapshot other than the exact
  pointer-requested object.

This means a normal same-window click will usually hide Tab Out before the
snapshot returns and will correctly produce no visible animation. The motion is
for pointer-driven reorders that commit while the dashboard remains visible,
such as a target in another visible window and the browser fixture used for
verification. Do not work around that limitation by delaying focus or replaying
the animation on return.

## Repo conventions to follow

- `src/styles/app.css:33` defines the dashboard's settled signature motion token:
  `--ease-swift: cubic-bezier(0.2, 0, 0, 1)`. Reuse it; do not introduce the
  generic audit playbook's `--ease-in-out` token for this one seam.
- `src/extension/history-entry-move-animation.ts:18` already configures the
  correct selector, `180ms` duration, root coordinate space, moving classes, and
  z-index. Extend its usage, not its values.
- `src/extension/move-animation.ts:177` performs interruptible FLIP with direct
  transforms, skips sub-pixel deltas, and cancels stale ownership. Do not create
  another animation engine or add a dependency.
- `src/components/TabHistoryPanel.tsx:177` shows the established read-before-
  mutation sequence for history removal: snapshot positions, mutate layout,
  then call `animateHistoryEntryMoves`.
- `src/components/TabHistoryPanel.tsx:1645` flushes title measurement work in a
  parent layout effect. Consume the pending reorder in a second layout effect
  immediately after that flush so final row geometry is measured before paint.
- `CONTEXT.md` is the durable behavior contract for Activation History. Record
  the narrow trigger and all excluded refresh paths there in the same patch.
- Source changes come first. Regenerate `extension/dist/*` with `pnpm build`;
  never hand-edit a bundle.

## Steps

1. **Document the behavior boundary in `CONTEXT.md`.**

   Add one Activation History contract beside the chronological switching rules:

   > A visible Activation History reorder may FLIP stable rows only after an
   > unmodified primary-pointer activation of a live indexed history row, and
   > only when the resulting exact snapshot commits while Tab Out remains
   > visible. Keyboard/modifier activation, startup or visibility reconciliation,
   > passive browser refreshes, ghost rows, and reduced-motion mode settle
   > immediately; tab focus is never delayed for motion.

2. **Separate React identity from FLIP identity in
   `src/components/TabHistoryPanel.tsx`.**

   Preserve the existing index-bearing key as `historyPanelRowRenderKey` and
   make `historyPanelRowLayoutKey` stable for stack rows:

   ```ts
   function historyPanelRowRenderKey(row: HistoryPanelRow): string {
     if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}:${row.entry.index}`
     if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
     return `closed-ghost:${row.closed.sessionId}`
   }

   function historyPanelRowLayoutKey(row: HistoryPanelRow): string {
     if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}`
     if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
     return `closed-ghost:${row.closed.sessionId}`
   }
   ```

   In `rows.map`, pass `key={historyPanelRowRenderKey(row)}` and
   `layoutKey={historyPanelRowLayoutKey(row)}`. Do not change keys for Page Chips,
   Domain Cards, or any non-history surface.

3. **Classify pointer provenance inside `TabHistoryPanel.tsx`.**

   Add an internal predicate with this exact contract:

   ```ts
   function isPrimaryPointerHistoryActivation(
     event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement> | undefined
   ): event is MouseEvent<HTMLDivElement> {
     return event?.type === 'click' &&
       'button' in event &&
       event.button === 0 &&
       event.detail > 0 &&
       !event.altKey &&
       !event.ctrlKey &&
       !event.metaKey &&
       !event.shiftKey
   }
   ```

   Add an internal optional `onPointerSnapshotChange: SnapshotChangeHandler`
   prop through `HistoryEntryProps`, `HistoryEntryActionsOptions`,
   `HistoryPanelRow`, and the stack-row `HistoryEntry`. Do not add it to the
   public `TabHistoryPanelProps` or to `App.tsx`.

   In `activateHistoryEntry`, calculate the activation mode first. Request the
   pointer reorder only when all three conditions hold:

   ```ts
   const pointerReorderRequested =
     kind === 'stack' &&
     mode === 'focus' &&
     isPrimaryPointerHistoryActivation(e)
   ```

   Pass that boolean into `onFocusEntry`. In the ordinary stack-entry branch,
   fetch once and route the result without changing focus timing:

   ```ts
   const result = await focusHistoryEntryResult(entry)
   if (!focusChangedActiveTab(result)) return
   const nextSnapshot = await fetchTabHistorySnapshot()
   if (pointerReorderRequested && onPointerSnapshotChange) {
     onPointerSnapshotChange(nextSnapshot)
   } else {
     onSnapshotChange?.(nextSnapshot)
   }
   ```

   Leave the existing Working Set and recently-closed branches on
   `onTabsChange`/`onSnapshotChange`; they must never call the pointer callback.

4. **Prime and consume exactly one pointer-requested snapshot in
   `TabHistoryPanel`.**

   Attach a new `historyContentRef` to `.history-entry-list-content`; the
   existing `historyListRef` remains owned by the scrollbar and must not change.
   Store the provenance and rectangles together:

   ```ts
   type PendingPointerHistoryReorder = {
     beforeSnapshot: TabHistorySnapshot | null
     nextSnapshot: TabHistorySnapshot
     positions: ReturnType<typeof snapshotHistoryEntryPositions>
   }
   ```

   The callback passed only to stack rows must follow this order:

   ```ts
   function handlePointerSnapshotChange(nextSnapshot: TabHistorySnapshot) {
     if (!onSnapshotChange) return
     const root = historyContentRef.current
     if (
       !root ||
       nextSnapshot === snapshot ||
       document.visibilityState !== 'visible'
     ) {
       onSnapshotChange(nextSnapshot)
       return
     }

     const positions = snapshotHistoryEntryPositions(root)
     if (positions.size > 0) {
       pendingPointerReorderRef.current = {
         beforeSnapshot: snapshot,
         nextSnapshot,
         positions
       }
     }
     onSnapshotChange(nextSnapshot)
   }
   ```

   Add a layout effect immediately after `flushHistoryTitleMeasurementJobs()`:

   ```ts
   useLayoutEffect(() => {
     const pending = pendingPointerReorderRef.current
     if (!pending || snapshot === pending.beforeSnapshot) return

     pendingPointerReorderRef.current = null
     if (
       snapshot !== pending.nextSnapshot ||
       document.visibilityState !== 'visible'
     ) return

     animateHistoryEntryMoves(historyContentRef.current, pending.positions)
   }, [snapshot])
   ```

   The exact-object check is the guard against a later passive or visibility
   snapshot stealing a stale pointer request. If React/Compiler lint requires a
   stable internal helper, follow the repo's existing callback policy; do not add
   `useCallback` merely as a performance guard.

5. **Add focused non-browser regressions.**

   - In `tests/history-entry-move-animation.test.ts`, add a three-row reorder
     using stable keys. Move the first row to the third position and assert that
     the surviving DOM rows receive the correct positive/negative
     `translate(0px, Npx)` inversions before play. Keep the current removal test.
   - In `tests/page-chip-highlight.test.ts`, render the same stack tab at two
     different `entry.index` values and assert its emitted
     `data-tabout-layout-key` is identical and omits the index. Also assert two
     different tab IDs do not collide.
   - If the pointer predicate is extracted for testability, keep it in an
     Activation-History-specific module and test pointer, Enter/Space, modifier,
     `detail === 0`, non-primary button, and Alt cases. Do not export a generic
     input abstraction solely for this plan.

6. **Add browser-layout coverage with generic fixture data.**

   Extend `tests/fixtures/dashboard-resize.html` behind a query parameter such as
   `historyReorderMotion=1`:

   - Supply at least three live stack entries backed by existing generic fake
     tabs.
   - Keep the backend `tabHistorySnapshot` replaceable without applying it to
     the mounted app, and expose a test-only helper that stages a reordered next
     snapshot for the next `tab-out:get-tab-history` or dashboard-service read.
   - Add a MutationObserver helper that records every addition of
     `history-entry-layout-moving` and
     `history-entry-layout-moving-active`; checking only the final class count
     can miss the `180ms` interval.

   In `tests/browser/dashboard-layout.spec.ts`, cover these cases independently
   (reload the fixture between cases):

   1. A Playwright primary-pointer `.click()` on a live stack row changes the
      order while the fake page remains visible; at least one stable survivor
      records the moving class, its inline transition is exactly
      `transform 180ms var(--ease-swift)`, and all rows settle with no inline
      transform/transition/will-change/z-index residue.
   2. Focusing the same row and pressing Enter applies the reordered snapshot
      but records zero moving-class additions.
   3. Pressing Space applies the snapshot but records zero moving-class
      additions.
   4. A modifier click applies its existing action semantics and records zero
      reorder moves.
   5. Stage the reordered dashboard-service snapshot and dispatch the fixture's
      passive tab-activation event; the order updates and records zero moves.
   6. Stage another snapshot and dispatch `visibilitychange` while the fixture is
      visible; the refresh updates order and records zero moves.
   7. With Playwright `reducedMotion: 'reduce'`, primary-pointer activation
      updates order and current-row styling but records zero positional moves.

   Assert that pointer activation is not delayed: record the fake
   `chrome.tabs.update(..., { active: true })` call before any moving-class
   addition. Do not assert that normal same-window Chrome keeps Tab Out visible;
   the fixture exists to isolate the permitted visible-commit branch.

7. **Regenerate the extension bundle.**

   Run `pnpm build`. Include only generated files that actually change; this
   plan is expected to change `extension/dist/app.js` and should not require a
   manifest, permission, dependency, or lockfile change. Never edit
   `extension/dist/*` by hand.

## Boundaries

- Do NOT animate all `snapshot`, `rows`, `chrome.tabs.onActivated`, window-focus,
  source, filter, startup, or visibility changes.
- Do NOT add an `animateHistory` option to `DashboardRefreshOptions`,
  `useDashboardRefresh`, `App`, `app.tsx`, or the background service. Provenance
  must remain inside the direct pointer action and its exact snapshot commit.
- Do NOT delay or make Chrome tab focus conditional on animation completion.
- Do NOT animate keyboard or modifier activation, even when it happens to emit a
  later browser `click` event.
- Do NOT animate row entry/exit, index text, current-row rings, opacity, scale,
  blur, scroll position, or list height as part of this plan.
- Do NOT change the existing close/forget exit ghost, its wait timing, or
  `LayoutRemovalAnimation`.
- Do NOT change `src/extension/move-animation.ts`, the `--ease-swift` token, or
  other FLIP adapters unless the current commit has drifted and the plan cannot
  be applied; in that case STOP and report rather than broadening scope.
- Do NOT add dependencies, change the manifest, or hand-edit generated bundles.
- Do NOT stage, commit, amend, or push unless the user separately requests it.
- Preserve fake/generic fixture URLs, titles, IDs, and domains.
- If any cited code or trigger path differs materially from commit `0a1f9dab`,
  STOP and report the drift instead of improvising.

## Verification

- **Mechanical**:
  1. `pnpm typecheck`
  2. `pnpm lint`
  3. `pnpm react-doctor`
  4. `pnpm verify:compiler`
  5. `pnpm build`
  6. `pnpm test`
  7. `pnpm test:browser:layout`
  8. `pnpm test:browser`
  9. `git diff --check`

  `pnpm verify` remains the repository's final authority in a commit workflow.
  Its `verify:bundle` step compares the worktree bundle to the index, so do not
  stage merely to make that step pass; if no staging/commit was requested, run
  the explicit sequence above and report an intentional generated diff clearly.

- **Feel check**:
  - Load the unpacked extension in real Chrome and place Tab Out and a target
    history tab in separately visible windows so the dashboard document can
    remain visible during pointer activation.
  - Click the live indexed history row. Tab focus must happen immediately; the
    rows that remain visible should travel continuously to their new positions
    for `180ms` without fading, scaling, changing scroll position, or flashing
    above the title expansion/scrollbar layers.
  - In DevTools Animations, set playback to 10%. Confirm each survivor starts at
    its old visual rectangle, moves only via `transform`, and finishes at the new
    DOM position with inline animation styles removed.
  - Return to Tab Out after a normal same-window click. Confirm the latest order
    appears immediately and no delayed/replayed movement runs on visibility.
  - Activate the row with Enter and Space, then use the extension's history
    keyboard command. Confirm every keyboard path remains immediate and still.
  - Test Shift-click and Cmd/Ctrl-click. Confirm existing move/open semantics are
    unchanged and no history reorder animation starts.
  - Toggle `prefers-reduced-motion: reduce` in DevTools Rendering. Confirm order,
    current-row ring, and marker emphasis update, but row positions do not move.

- **Done when**:
  - A visible, unmodified primary-pointer activation of a live indexed history
    row produces exactly one interruptible `180ms` survivor FLIP keyed by stable
    tab identity.
  - Keyboard, modifier, startup, passive tab/window, visibility, hidden-document,
    ghost-row, failed-focus, stale-snapshot, and reduced-motion paths record zero
    reorder moves.
  - Focus is never delayed, existing close/forget motion is unchanged, all
    generated output is rebuilt from source, and the full mechanical/browser
    verification above passes or has a precisely documented environmental
    blocker.

## Verification result

- Completed: typecheck, lint, React Doctor, compiler baseline, build, all 1,001
  unit tests, all 58 browser-layout tests, the focused Activation History
  scrollbar smoke, and `git diff --check`.
- `pnpm test:browser` has one unrelated existing selector mismatch: the rapid
  domain-pin smoke waits for a direct `Pin contentful.com` button, while the
  current card UI exposes pinning through the `Actions for contentful.com`
  menu. A focused rerun reproduces the same timeout; this plan leaves that
  separate test and product surface unchanged.
- Real-Chrome two-window feel inspection remains manual because the automated
  fixture isolates the otherwise timing-dependent visible-document branch.
