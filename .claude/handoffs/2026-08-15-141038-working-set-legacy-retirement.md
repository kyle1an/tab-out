# Handoff: Retire legacy Working Set activity on another Chrome profile

## Session Metadata

- Repository: Tab Out
- Branch: `dev`

### Recent Commits (for context)

- `44491dc3 fix(page-chip): unify URL variant presentation`
- `a35b1f29 refactor(runtime): rely on supported native APIs`
- `8f446d3c build(chrome): set Apple silicon support floor to 151`

## Handoff Chain

- **Continues from**: None
- **Supersedes**: None

## Current State Summary

The commit containing this handoff adds update-only retirement of the legacy
`workingSetActivity` value from `chrome.storage.local`. The already-committed
authority adapter still owns the restart-safe, data-preserving cutover into
IndexedDB. The new path runs after update reconciliation, performs an
authoritative semantic read of the exact marked IndexedDB generation, and only
then removes the stale legacy value. It was verified with unit, integration,
bundle, and live real-Chrome evidence on the originating machine. The remaining
task is to reload the unpacked extension on the other machine and collect the
same sanitized postconditions for that independent Chrome profile.

## Codebase Understanding

## Architecture Overview

Working Set activity uses a Chrome-storage authority marker named
`tab-out:working-set-activity-authority`. When the marker is absent, the
authority adapter reads and validates the legacy `workingSetActivity` envelope,
stages and verifies an IndexedDB generation, then commits and confirms the
marker. When the marker exists, only its exact IndexedDB generation is
authoritative; the legacy value is never shadow-written or used as fallback.
The retirement path is serialized with normal storage operations and is
failure-contained so startup snapshot refresh still settles.

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/extension/background.ts` | MV3 service-worker event wiring | Runs retirement only for `runtime.onInstalled` reason `update`, after reconciliation |
| `src/extension/background/working-set-activity-authority.ts` | Authority and cutover state machine | Validates the marked target before removing legacy storage |
| `src/extension/background/working-set-activity-storage.ts` | Effect service boundary | Exposes typed, failure-mapped `retireLegacy()` |
| `src/extension/background/working-set-activity-storage-layer.ts` | Chrome and IndexedDB ports | Wires the exact legacy-key removal operation |
| `docs/adr/0017-store-working-set-activity-in-indexeddb.md` | Durable architecture rationale | Documents cutover, retirement, failure, and rollback boundaries |
| `CONTEXT.md` | Product behavior contract | Defines the update-only safe-removal contract |
| `extension/dist/background.js` | Generated unpacked service worker | This is the artifact Chrome actually executes |

### Key Patterns Discovered

- A missing legacy key is an idempotent success.
- Marker, IndexedDB generation, cached truth, and visible ranking never change
  as part of retirement.
- A failed target read or Chrome removal preserves the legacy key.
- There is no timer, alarm, shadow write, downgrade projection, or hidden retry.
- `chrome.storage.local` and extension IndexedDB are profile-local; another
  machine must be checked independently.

## Work Completed

### Tasks Finished

- [x] Added update-only legacy retirement after initial reconciliation.
- [x] Added exact-target validation before Chrome-storage removal.
- [x] Added Effect service/layer wiring and unit/integration coverage.
- [x] Regenerated `extension/dist/background.js` through the repository build.
- [x] Updated `CONTEXT.md` and ADR 0017.
- [x] Verified the originating real Chrome profile without reading stored URLs
  or record values.

## Files Modified

| File group | Changes | Rationale |
|------------|---------|-----------|
| `src/extension/background.ts` and storage authority/service/layer files | Added serialized retirement and update wiring | Make cleanup automatic and failure-safe per profile |
| `tests/background-pinned-dashboard.test.ts` and Working Set storage/authority tests | Added success, failure, ordering, and idempotence coverage | Protect marker and target authority invariants |
| `tests/extension/working-set-backends/current-envelope-layer.ts` | Added the new port method to the packaged test layer | Keep packaged-extension fixtures current |
| `CONTEXT.md` and ADR 0017 | Recorded the durable cleanup boundary | Prevent future shadow-write or unsafe-delete regressions |
| `extension/dist/background.js` | Rebuilt generated service worker | Ship the source change to unpacked Chrome |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Preserve legacy data during cutover, then retire it | Blind deletion, console-only reset, verified retirement | Existing activity is retained while cleanup remains safe on dormant profiles |
| Trigger only on extension update | Startup, alarm, every read, update | Update is the explicit release boundary and avoids recurring cleanup work |
| Validate current marked authority before deletion | Marker-only check, direct delete, semantic read | The stale value is removed only when the actual target is readable |
| Keep failures local | Fail all startup work, retry later, settle retirement | Startup refresh can continue while the key remains available for diagnosis |

## Pending Work

## Immediate Next Steps

1. On the other machine, pull the commit containing this handoff and confirm
   `git status --short` has no unrelated local changes. The committed generated
   `extension/dist/background.js` is the runtime artifact; do not hand-edit it.
2. In real Chrome, open `chrome://extensions`, enable Developer mode if needed,
   open Tab Out details, and confirm **Loaded from** points to that machine's
   intended checkout `extension/` directory. Click Tab Out's **Reload** button.
3. Open Tab Out and confirm the dashboard renders. From the Tab Out service
   worker DevTools console, run the sanitized probe below and report only its
   metadata/count output. Also confirm both service-worker and dashboard
   consoles show no errors.

```js
JSON.stringify(await (async () => {
  const legacyKey = 'workingSetActivity'
  const markerKey = 'tab-out:working-set-activity-authority'
  const storage = await chrome.storage.local.get([legacyKey, markerKey])
  const marker = storage[markerKey]
  const databaseName = marker
    ? `tab-out:working-set-activity:${marker.generation}`
    : null
  const databaseInfo = databaseName
    ? (await indexedDB.databases()).find(({ name }) => name === databaseName)
    : undefined
  let physical = null

  if (databaseInfo) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onupgradeneeded = () => request.transaction?.abort()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const stores = [...database.objectStoreNames]
      const storesOk = stores.length === 2 &&
        stores.includes('page-activity') &&
        stores.includes('generation-manifest')
      if (storesOk) {
        const transaction = database.transaction(
          ['page-activity', 'generation-manifest'],
          'readonly',
        )
        const pages = transaction.objectStore('page-activity')
        const manifests = transaction.objectStore('generation-manifest')
        const rowCount = await new Promise((resolve, reject) => {
          const request = pages.count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const manifest = await new Promise((resolve, reject) => {
          const request = manifests.get('active')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const manifestMatches = Boolean(manifest) && [
          'schemaVersion',
          'generation',
          'sourceDigest',
          'recordCount',
          'eventCount',
          'retainedAfter',
        ].every((field) => manifest[field] === marker[field])
        const indexes = [...pages.indexNames]
        physical = {
          storesOk,
          indexOk: indexes.length === 1 && indexes[0] === 'last-event-at',
          manifestMatches,
          rowCount,
        }
      } else {
        physical = {
          storesOk,
          indexOk: false,
          manifestMatches: false,
          rowCount: null,
        }
      }
    } finally {
      database.close()
    }
  }

  return {
    legacyPresent: Object.prototype.hasOwnProperty.call(storage, legacyKey),
    markerPresent: Boolean(marker),
    backend: marker?.backend ?? null,
    schemaVersion: marker?.schemaVersion ?? null,
    markedDatabasePresent: Boolean(databaseInfo),
    databaseVersion: databaseInfo?.version ?? null,
    physical,
  }
})())
```

Expected postconditions on an existing profile are:

- `legacyPresent: false`
- `markerPresent: true`
- `backend: "idb"`
- `schemaVersion: 1`
- `markedDatabasePresent: true`
- `databaseVersion: 1`
- `physical.storesOk`, `indexOk`, and `manifestMatches`: all `true`
- `physical.rowCount`: a non-negative profile-specific number

### Blockers/Open Questions

- None. If Reload does not produce the expected postconditions, stop and report
  the sanitized object plus console error text. Do not delete any marker or
  IndexedDB database manually.

### Deferred Items

- Removing the retirement handler after a future compatibility window is
  optional maintenance. No removal release has been selected.
- A downgrade rollback projection remains deliberately unimplemented and is
  not required for retirement.

## Context for Resuming Agent

## Important Context

The other machine does not need uncommitted TypeScript source after this commit
is pulled: the source, tests, docs, and generated background bundle travel
together. A current committed build already knows how to perform the
data-preserving marker-absent cutover; this commit adds automatic verified
deletion of the stale Chrome-storage copy. Do not substitute a bare
`chrome.storage.local.remove('workingSetActivity')` call before authority is
known. A fresh profile may have no legacy key, which is a valid no-op, while an
older profile should migrate and retire during the update/reload path.

Originating-machine live proof after extension reload was:

- legacy key absent;
- authority marker present with IndexedDB backend and schema 1;
- marked database version 1 present;
- required stores, index, and manifest valid;
- dashboard rendered with zero service-worker and page console errors or
  warnings.

The live probe intentionally returned only booleans, schema metadata, and a row
count. It did not read or print stored URLs, titles, or event records.

## Assumptions Made

- The other machine has a Chrome profile that previously used Tab Out and may
  still contain the legacy value.
- The checkout uses the same repository build and Chrome loads its `extension/`
  directory as an unpacked extension.
- Preserving recent Working Set ranking and dismissal evidence is preferable to
  intentionally resetting it.

## Potential Gotchas

- Reload the extension card, not only the Tab Out page; service-worker changes
  require an extension reload.
- Confirm **Loaded from** before reload so a different clone is not tested.
- Current row count can differ from the marker's original cutover record count
  because activity remains mutable and retention continues. Require manifest
  equality and a successful runtime read; do not require those counts to match.
- The DevTools probe is corroborating evidence. The product retirement path is
  what performs the authoritative semantic read before deletion.
- Chrome extension storage is profile-local and does not transfer with the Git
  checkout.

## Environment State

### Tools/Services Used

- Real Google Chrome via Computer Use for unpacked-extension reload and live QA.
- Service-worker and dashboard DevTools consoles for sanitized verification.
- Pinned Node and pnpm repository toolchain for build and tests.

### Active Processes

- No repository development server or watcher is required for the handoff.

### Environment Variables

- None required.

## Related Resources

- `CONTEXT.md`
- `docs/adr/0017-store-working-set-activity-in-indexeddb.md`
- `AGENTS.md`
- `src/extension/background/working-set-activity-authority.ts`
- `src/extension/background/working-set-activity-indexed-db.ts`

---

**Security Reminder**: The verification probe must remain metadata-only; do not
print persisted Working Set record contents.
