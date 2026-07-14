# 009 — Stabilize App's dashboard seams (context value + handler props)

- **Status**: DONE (`8350a33`)
- **Commit**: `119ec06`
- **Severity**: HIGH
- **Category**: Performance
- **Rule**: react-doctor/jsx-no-constructed-context-values (+ React Compiler bailout, beyond the scan)
- **Estimated scope**: 2 files (`src/components/App.tsx`, `src/hooks/useDashboardRefresh.ts`), ~60 changed lines

## Problem

React Compiler **bails out on `App`** (`src/components/App.tsx:538`) with five
"Cannot access refs during render" diagnostics. The ref reads are deliberate,
documented architecture (see the `react-doctor-disable-next-line
react-hooks-js/refs` comments at `App.tsx:670`, `App.tsx:680`, `App.tsx:720`,
`App.tsx:807` — mutable ordering caches read at build time). **Do not try to
make App compile.** The consequence to fix is different: because App is
uncompiled, nothing in its body is auto-memoized, and App re-renders on every
hover transition (`hoverMatch` state from `useHoverMatch`, `App.tsx:548`) and
on every filter keystroke (`filterInput` state from `useFilterRouting`,
`App.tsx:634`).

Unstable values rebuilt on each of those renders:

1. **The actions context value** — an inline object literal:

   ```tsx
   // src/components/App.tsx:852-860 — current
   <DashboardActionsProvider
     value={{
       onHoverUrlChange: handleHoverUrlChange,
       onLayoutChange: scheduleMissionsMasonry,
       onTogglePinnedDomain: togglePinnedDomain,
       onReorderPinnedDomain: reorderPinnedDomain,
       onTogglePinnedSection: togglePinnedSection,
       onTogglePinnedPageChip: togglePinnedPageChip
     }}
   >
   ```

   Every App render creates a new object → `DashboardActionsContext` changes →
   **every consumer re-renders**: every `DomainCard`
   (`src/components/DomainCard.tsx:175`), every `PageChip`
   (`src/components/PageChip.tsx:907`), `PageChipOverflow`
   (`src/components/PageChipOverflow.tsx:54`), and `TabHistoryPanel`
   (`src/components/TabHistoryPanel.tsx:1396`). This directly contradicts the
   context's own design comment (`src/components/DashboardInteractionContext.tsx:22`:
   "These never change identity across renders") — that comment assumed App
   compiles.

2. **Handler props to `DashboardShell`** — fresh closures per render:

   ```tsx
   // src/components/App.tsx:567-575 — current (plain function declarations)
   function setHistoryRange(nextHistoryRange: string) {
     dispatchAppDashboard({ type: 'historyRange', historyRange: nextHistoryRange })
   }
   function setTabHistory(nextTabHistory: TabHistorySnapshot | null) {
     dispatchAppDashboard({ type: 'tabHistory', tabHistory: nextTabHistory })
   }
   ```

   ```tsx
   // src/components/App.tsx:761-767 — current
   async function onCloseFiltered() {
     await closeFilteredTabs(dashboardVm.filteredCloseUrls)
   }

   async function onDedupAll() {
     await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
   }
   ```

   ```tsx
   // src/components/App.tsx:769 — current (function declaration)
   function onSourceChange(nextSource: DashboardSource) {
   ```

   ```tsx
   // src/components/App.tsx:877 — current (inline arrow prop)
   onTabsChange={() => refreshDashboard({ animateCards: true })}
   ```

   `DashboardShell` IS compiled, so it memoizes its children (`TabHistoryPanel`,
   `HeaderBar`, `DashboardMissionsList`) against prop identity — but these
   unstable props invalidate that memoization every App render.

3. **`refreshDashboard` itself** — `useDashboardRefresh` also bails out of the
   compiler (try/finally at `src/hooks/useDashboardRefresh.ts:218` is
   unsupported syntax, and the render-time `refreshRef.current = …` assignment
   at line 194 is its deliberate latest-callback architecture — leave both).
   Its return statement builds a fresh arrow every call:

   ```ts
   // src/hooks/useDashboardRefresh.ts:253 — current
   return (options?: RefreshOptions) => refreshRef.current(options)
   ```

   So even a `useCallback`-wrapped `onTabsChange` would re-fire on every render
   until this returns a stable function.

4. **`missionSections`** — a fresh array of fresh objects per render
   (`src/components/App.tsx:808-829`), invalidating the missions list subtree.

5. **`closedTabs={dashboardContentVisible ? closedTabs : []}`**
   (`src/components/App.tsx:864`) — the `[]` literal is a new array each render
   during the pre-visible startup frames.

User impact: with N open tabs, every single hover enter/leave and every filter
keystroke re-renders all N chips, all domain cards, the header, and the history
panel. This multiplies with plan 010 (the chip body is also uncompiled today).

## Target

The canonical recipe for `react-doctor/jsx-no-constructed-context-values`
(fetched from react.doctor): "Wrap the value in `useMemo` for objects/arrays or
`useCallback` for functions, keyed on actual dependencies." Applied here —
manual memoization works fine inside a compiler-bailed component:

```tsx
// src/components/App.tsx — target: memoized context value
const dashboardActions = useMemo(
  () => ({
    onHoverUrlChange: handleHoverUrlChange,
    onLayoutChange: scheduleMissionsMasonry,
    onTogglePinnedDomain: togglePinnedDomain,
    onReorderPinnedDomain: reorderPinnedDomain,
    onTogglePinnedSection: togglePinnedSection,
    onTogglePinnedPageChip: togglePinnedPageChip
  }),
  [handleHoverUrlChange, scheduleMissionsMasonry, togglePinnedDomain, reorderPinnedDomain, togglePinnedSection, togglePinnedPageChip]
)
…
<DashboardActionsProvider value={dashboardActions}>
```

All six handlers are already stable: `handleHoverUrlChange` comes from the
compiled `useHoverMatch`, `scheduleMissionsMasonry` is manually `useCallback`'d
in `src/extension/layout.ts:191`, and the four pin toggles come from the
compiled `useDashboardLocalState`.

```tsx
// target: stable dispatch wrappers (dispatch from useReducer is lint-known-stable)
const setHistoryRange = useCallback((nextHistoryRange: string) => {
  dispatchAppDashboard({ type: 'historyRange', historyRange: nextHistoryRange })
}, [])
const setTabHistory = useCallback((nextTabHistory: TabHistorySnapshot | null) => {
  dispatchAppDashboard({ type: 'tabHistory', tabHistory: nextTabHistory })
}, [])
```

```tsx
// target: stable action handlers
const onCloseFiltered = useCallback(async () => {
  await closeFilteredTabs(dashboardVm.filteredCloseUrls)
}, [dashboardVm.filteredCloseUrls])

const onDedupAll = useCallback(async () => {
  await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
}, [dashboardVm.globalDedupeUrls])

const onSourceChange = useCallback((nextSource: DashboardSource) => {
  /* body unchanged, verbatim from App.tsx:769-800 */
}, [source, filter, historyRange, historyFilterEnabled, pinnedDomains, clearHoverUrlNow, currentMissionContainers])
// ^ let `pnpm lint` dictate the final array — add exactly what
//   react-hooks/exhaustive-deps asks for, nothing more. Refs are exempt.

const onTabsChange = useCallback(() => refreshDashboard({ animateCards: true }), [refreshDashboard])
…
onTabsChange={onTabsChange}
```

```ts
// src/hooks/useDashboardRefresh.ts:253 — target: stable return
return useCallback((options?: RefreshOptions) => refreshRef.current(options), [])
```

(`useCallback` must be added to the react import of that file.)

```tsx
// target: memoized sections (body of the call unchanged, verbatim)
const missionSections = useMemo(() => dashboardMissionSections({
  /* same 19 arguments, verbatim from App.tsx:808-829 */
}), [bookmarkMatchedCards, bookmarkMatchesFlush, filter, historyMatchedCards, historyMatchesFlush, isReady, matchedCards, otherTabsFlush, primaryMissionsEmpty, showBookmarkMatches, showHistoryMatches, showHistoryRange, showOtherTabs, showPrimaryEmptyState, source, unmatchedCards])
```

Keep the existing `react-doctor-disable-next-line react-hooks-js/refs` comment
(currently `App.tsx:807`) immediately above whatever line `pnpm react-doctor`
flags after the wrap — the directive must sit directly adjacent to the flagged
line or it does not apply.

```tsx
// target: hoisted empty-list constant (module scope, near PROGRESSIVE_CARD_* consts)
const EMPTY_CLOSED_TABS: readonly ClosedTabEntry[] = []
…
closedTabs={dashboardContentVisible ? closedTabs : EMPTY_CLOSED_TABS}
```

## Repo conventions to follow

- Exemplar for named-function `useCallback` style: `refreshClosedTabs` at
  `src/components/App.tsx:579-586` (`useCallback(async function refreshClosedTabs() {…}, [])`).
  Keep the named-function-expression style where the current code has a named
  function.
- Exemplar for the empty-array constant: `EMPTY_CLOSED_TABS` default in
  `src/components/TabHistoryPanel.tsx:1389`.
- Two-space indent, no semicolons, single quotes — match the file.

## Steps

1. In `src/hooks/useDashboardRefresh.ts`, change line 253 to the
   `useCallback`-wrapped return above and extend the `react` import.
2. In `src/components/App.tsx`, convert `setHistoryRange` and `setTabHistory`
   (lines 567-575) to `useCallback` with `[]` deps. Leave `setClosedTabs`,
   `setDashboard`, `setStartupSnapshot`, `setWorkingSet` as plain functions —
   they are only passed into `useDashboardRefresh`, which reads them through a
   render-assigned closure; their identity never affects rendering.
3. Convert `onCloseFiltered`, `onDedupAll` (761-767) and `onSourceChange`
   (769-800) to `useCallback`, bodies verbatim. Run `pnpm lint` and satisfy
   `react-hooks/exhaustive-deps` exactly (the repo runs `--max-warnings=0`).
4. Add the `onTabsChange` `useCallback` and replace the inline arrow at 877.
5. Add the `dashboardActions` `useMemo` and pass it to
   `DashboardActionsProvider` (852-860).
6. Wrap the `dashboardMissionSections(…)` call (808-829) in `useMemo`,
   arguments verbatim; reposition the refs disable-comment if `pnpm
   react-doctor` reports it off-target.
7. Hoist `EMPTY_CLOSED_TABS` and use it at line 864.
8. Re-read the diff: no logic edits, only wrapping/identity changes.

## Boundaries

- Do NOT touch the `previousOrderRef.current` / `chipOrderRef.current` reads
  (App.tsx:681, 721) or any `react-doctor-disable-next-line` comment's content
  — that architecture is settled (see the comments' own rationale).
- Do NOT try to make `App` or `useDashboardRefresh` compile (no ref
  restructuring, no try/finally rewrite). This plan is manual seam
  stabilization only.
- Do NOT change `DashboardInteractionContext.tsx`, any consumer component, or
  user-visible behavior. No new dependencies.
- STOP if the code has drifted from commit `119ec06`; report the drift instead
  of improvising.

## Verification

- **Mechanical**:
  - `pnpm verify` passes (typecheck, lint at zero warnings, react-doctor gate,
    build, bundle diff, tests). Build output must be staged with the source
    change (`extension/dist` is tracked).
  - `pnpm react-doctor:diff` reports no new diagnostics.
- **Behavior check** (React DevTools Profiler against the unpacked extension or
  `pnpm serve` + `extension/index.html`, with a dashboard showing 20+ tabs):
  1. Start profiling, hover across several page chips, stop. **Before** this
     plan: every `DomainCard`, `HeaderBar`, and all `PageChip`s render on each
     hover. **After**: `App`/`DashboardShell`/`TabHistoryPanel` and `PageChip`s
     still render (hover context is designed to reach them — plan 010 makes the
     chip renders cheap), but `DomainCard`, `HeaderBar`, `Missions`, and
     `MissionBlock` must NOT render on hover.
  2. Type one character in the filter (within the 200 ms debounce): only `App`,
     `DashboardShell`, and `HeaderBar` may render; missions, cards, chips, and
     the history panel must not (until the debounced `filter` commits).
  3. Confirm pin toggle, dedupe, close-filtered, source switch, and
     tab-close-triggered refresh (`onTabsChange`) still work.
- **Done when**: profiler shows the hover/keystroke fan-out is gone, all
  interactions behave identically, and `pnpm verify` is green.
