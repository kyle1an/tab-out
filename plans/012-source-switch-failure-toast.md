# 012 — Surface source-switch failures instead of swallowing them

- **Status**: DONE (`7361a3c`)
- **Commit**: `119ec06`
- **Severity**: MEDIUM
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan (silent failure on a primary control)
- **Estimated scope**: 1 file (`src/components/App.tsx`), ~3 changed lines

## Problem

`onSourceChange` — the handler behind the Tabs / Bookmarks / History source
switch in the header — swallows every failure with an empty catch:

```tsx
// src/components/App.tsx:775-799 — current
    void (async () => {
      try {
        if (requestId !== sourceSwitchSeqRef.current) return
        // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await requestId comparison is a stale-response race guard; it must run after the await.
        const { dashboard: nextDashboard, tabHistory: nextTabHistory, workingSet: nextWorkingSet } = await fetchDashboardSnapshot({
          source: nextSource,
          filter,
          historyRange,
          historyFilterEnabled,
          pinnedDomains,
          previousOrder: previousOrderRef.current
        })
        if (requestId !== sourceSwitchSeqRef.current) return
        layoutMoveRectsRef.current = previousRects
        startSourceTransition(() => {
          dispatchAppDashboard({ … })
        })
      } catch {}
    })()
```

If `fetchDashboardSnapshot` rejects (the tabs gateway never throws by contract
— `src/extension/browser-tabs-gateway.ts:9` — but the snapshot pipeline also
crosses storage, bookmark/history search, and parsing layers), the click on
"Bookmarks" or "History" does nothing at all: the source never changes, no
message appears, nothing is logged. The user gets a dead control with no way to
distinguish "broken" from "slow".

The repo's own convention for exactly this situation is a toast — see
`useDashboardLocalState` wiring in the same file:

```tsx
// src/components/App.tsx:657-659 — the repo's error-feedback convention
    onDomainPinSaveError: () => showToast('Could not save pinned domain'),
    onSectionPinSaveError: () => showToast('Could not save pinned section'),
    onPageChipPinSaveError: () => showToast('Could not save pinned page')
```

## Target

```tsx
// target — only the catch clause changes
      } catch {
        if (requestId !== sourceSwitchSeqRef.current) return
        showToast('Could not switch source')
      }
```

- The `requestId` guard mirrors the success path: if a newer switch superseded
  this one, its failure is moot — do not toast for a stale attempt.
- `showToast` is already imported in `App.tsx` (line 6, from
  `../extension/toast.js`).
- No state cleanup is needed on failure: `layoutMoveRectsRef` is only written
  after a successful fetch, and the pre-fetch `setStartupPriorityWorkingSet(null)`
  / `clearHoverUrlNow()` calls are harmless on the unchanged source. A retry is
  just clicking the switch again, which works because the sequence counter
  advances per attempt.

## Repo conventions to follow

- Toast copy style: short, sentence-case, "Could not …" for failures
  (exemplars above; also `'Could not save pinned section'`,
  `'Could not delete history'` in `src/extension/tab-actions.ts:206`).
- Keep the `react-doctor-disable-next-line react-doctor/async-defer-await`
  comment untouched — the race-guard design is settled.

## Steps

1. At `src/components/App.tsx:798`, replace `} catch {}` with the target catch
   clause above.
2. If plan 009 has already landed, `onSourceChange` is a `useCallback` — the
   edit is identical inside it and no dependency changes are needed
   (`showToast` is a module import, `sourceSwitchSeqRef` is a ref).
3. Re-read the diff — it should be the catch clause only.

## Boundaries

- Do NOT add retry logic, error state, console logging, or touch the success
  path. One toast, guarded by the sequence check.
- STOP if the code has drifted from commit `119ec06` (or from plan 009's
  landed shape, if that executed first).

## Verification

- **Mechanical**: `pnpm verify` passes; build output staged with the source
  change (`extension/dist` is tracked).
- **Behavior check** (unpacked extension or `pnpm serve` +
  `extension/index.html`):
  1. Normal path: switch Tabs → Bookmarks → History → Tabs; all switches work,
     no toast appears.
  2. Failure path: in DevTools on the dashboard page, break the fetch once —
     e.g. run
     `const q = chrome.bookmarks.search; chrome.bookmarks.search = () => Promise.reject(new Error('x'))`
     then click "Bookmarks" (restore with `chrome.bookmarks.search = q`). If
     that layer absorbs the failure (gateway-style), instead temporarily throw
     inside `fetchDashboardSnapshot` in a local build. Expected: the "Could not
     switch source" toast appears, the dashboard stays on the previous source
     and remains interactive, and clicking the switch again after restoring
     succeeds.
  3. Stale-race path (optional): confirm rapid double-switch still lands on the
     last clicked source with no spurious toast.
- **Done when**: the failure toast shows on a broken switch, recovery works by
  re-clicking, and the normal path is unchanged.
