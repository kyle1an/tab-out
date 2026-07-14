# 011 — Let React Compiler compile the history-row expansion hook (effect-ize one ref write)

- **Status**: DONE (`60b8ee8`)
- **Commit**: `119ec06`
- **Severity**: MEDIUM
- **Category**: Performance
- **Rule**: react-hooks-js/refs (React Compiler "Cannot access refs during render" bailout)
- **Estimated scope**: 1 file (`src/components/TabHistoryPanel.tsx`), ~5 changed lines

## Problem

`useHistoryEntryExpansion` (`src/components/TabHistoryPanel.tsx:524`) — the
hook every history row runs — **bails out of React Compiler** because it
assigns a ref during render:

```tsx
// src/components/TabHistoryPanel.tsx:567-569 — current
  const updateHistoryEntryExpansionMeasurementsRef = useRef(() => {})
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-callback ref pattern; the ref is only invoked later from the fonts-loaded effect, never read for render output.
  updateHistoryEntryExpansionMeasurementsRef.current = updateHistoryEntryExpansionMeasurements
```

Because the hook is uncompiled, its return object (`HistoryEntryExpansion`,
lines 505-522) and every handler in it are fresh identities on each row render,
invalidating the compiled `HistoryEntry` component's internal memoization for
that row's subtree on every re-render (rows re-render when their hover-derived
props change and whenever the snapshot updates).

The suppression comment itself states the fix is safe: "the ref is only
invoked later from the fonts-loaded effect" (the consumer is the
`document.fonts` effect at `TabHistoryPanel.tsx:634-652`). Effect-time
assignment is therefore sufficient — and the codebase already uses exactly
that compiler-legal pattern for the same problem in PageChip:

```tsx
// src/components/PageChip.tsx:978-980 — the repo's own exemplar
  useEffect(() => {
    updateChipTextMeasurementsRef.current = updateChipTextMeasurements
  }, [updateChipTextMeasurements])
```

## Target

```tsx
// src/components/TabHistoryPanel.tsx — target (suppression comment removed)
  const updateHistoryEntryExpansionMeasurementsRef = useRef(() => {})
  useEffect(() => {
    updateHistoryEntryExpansionMeasurementsRef.current = updateHistoryEntryExpansionMeasurements
  })
```

Notes on the shape:

- `updateHistoryEntryExpansionMeasurements` is a plain function declared in the
  hook body (line 559), so it has a new identity each render; the effect runs
  with **no dependency array** (every render) to always hold the latest — this
  matches how the value behaves today, just moved from render-time to
  commit-time.
- The assignment effect MUST be placed before the fonts-loaded effect in
  source order (it currently sits at 567-569, well before 634) so it runs
  first within the same commit — keep it in place, just wrapped.
- Remove the `react-doctor-disable-next-line react-hooks-js/refs` comment at
  line 568 — it documents exactly this render-time write and becomes stale.
- `useEffect` is already imported in the file.

## Repo conventions to follow

- Exemplar: `src/components/PageChip.tsx:978-980` (identical pattern, adjacent
  purpose). Two-space indent, no semicolons, single quotes.

## Steps

1. Wrap the assignment at `TabHistoryPanel.tsx:569` in `useEffect` as shown;
   delete the suppression comment at line 568.
2. Run the compiler verification script from plan 010 step 2:
   `node /tmp/compiler-check.mjs src/components/TabHistoryPanel.tsx`.
   **Before**: one `fn@524` "Cannot access refs during render" error.
   **After**: exit 0, with `useHistoryEntryExpansion` (fn at ~524) in the
   compiled list alongside `HistoryEntry`, `TabHistoryPanel`, etc. If a NEW
   compiler error surfaces once this one clears, STOP and report it.

## Boundaries

- Only this one pattern in `src/components/TabHistoryPanel.tsx`. Do not touch
  the other suppression in the file (`prefer-tag-over-role` at line 1267 —
  settled: nested-interactive DOM) or the lazy-init ref pattern in
  `src/components/title-expansion/use-title-expansion.ts` (settled: returns a
  stable facade; its bailout is harmless).
- No behavior changes, no new dependencies.
- STOP if the code has drifted from commit `119ec06`.

## Verification

- **Mechanical**:
  - Compiler check exits 0 for `TabHistoryPanel.tsx` (per step 2).
  - `pnpm verify` passes; build output staged with the source change
    (`extension/dist` is tracked).
- **Behavior check** (unpacked extension or `pnpm serve` +
  `extension/index.html`, history panel visible on the `tabs` source):
  1. Hover a long-titled history row → the row expansion still opens with
     correct multi-line layout, and closes on leave.
  2. With DevTools open, run `document.fonts.dispatchEvent(new Event('loadingdone'))`
     on the dashboard page — no errors, and a truncated row re-measures (the
     fonts-loaded consumer still reaches the latest callback through the ref).
  3. React DevTools Profiler: scroll/hover the history list — row render
     durations should not regress, and repeated hovers should show cheaper row
     re-renders than a pre-change profile.
- **Done when**: compiler check is clean, `pnpm verify` is green, and row
  expansion + fonts re-measure behave identically.
