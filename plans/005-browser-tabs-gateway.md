# 005 — Put a real seam under Tab Actions: the Browser Tabs Gateway

- **Status**: TODO
- **Commit**: 65a90ab
- **Strength**: Strong (architecture review 2026-07-12, candidate 1; carried and re-verified across three reviews)
- **Category**: ports & adapters
- **Estimated scope**: 1 new module + 1 fake factory + ~7 migrated modules across 3 commit waves

## Problem

The Chrome seam is ambient: 33 modules under `src/` touch the `chrome` global directly, 21 test files each patch `globalThis` with a partial hand-rolled fake, and the resize fixture ships its own `window.chrome` object (`tests/fixtures/dashboard-resize.html:368-444`). Two modules have already independently invented a narrow injectable chrome type to escape this (`tab-focus.ts:4-17` `ChromeTabFocusApi`, `tab-move.ts:19-24`) — the seam wants to exist. `tabs.ts:35` leaks mutable module state (`export let openTabs`). Three Tab Actions (`tab-actions.ts:160-211`, `:252-276`, `:341-372`) duplicate the same suspender-aware "resolve chip target → live tabs" matching block.

## Target (decisions from the 2026-07-12 grilling — do not re-litigate)

1. **Scope**: tabs-shaped commands only — `chrome.tabs/windows/tabGroups/sessions` + the cross-extension `runtime.sendMessage` unsuspend. `chrome.storage`/`history`/`bookmarks` and all event listeners (`app.tsx:53-105`) stay out.
2. **Altitude**: thin command gateway (~14 ops, browser vocabulary, never throws — errors normalize to `null`/`false`/`[]`/counts; owns quirks like undo's create-with-fallback-URL retry and the external-suspender unsuspend handshake). **Policy stays in Tab Actions.** The duplicated chip-target matching becomes a **pure function** (`live-tab-matching.ts`): plain tab arrays in, matching tabs out; CONTEXT.md records it against **Dashboard Item Identity**.
3. **State**: gateway stateless. The `openTabs` cache stays in `tabs.ts` (candidate 5 relocates it later).
4. **Wiring**: the seam is the chrome-shaped input. `export type ChromeTabsApi` (in the gateway module) is the narrow subset actually called. The gateway resolves `globalThis.chrome` **per call** (never cached at module load — legacy tests patch the global in any order) and offers `setChromeTabsApi(api | null)` for direct injection.
5. **One fake**: `tests/helpers/fake-chrome.mjs` — browser-native ES module, JSDoc-typed, with a `fake-chrome.d.mts` declaration sidecar (repo has `allowJs: false`). `createFakeChromeApi(state)` returns a chrome-shaped object: real `tabs.query/get/remove/update/create/move/group` over caller-owned state, `windows.*`, `tabGroups.query`, `sessions.getRecentlyClosed`, `runtime.getURL/sendMessage` (handler injectable), `storage.local.get/set` over a seed object, `bookmarks.getTree`/`history.search` stubs, and every `on*` event as `{ addListener, removeListener, dispatch }` — the fixture already calls `.dispatch(...)` (`dashboard-resize.html:778`).
6. **Migration**: seam-first commits (see Steps). The 21 `globalThis`-patching test files stay untouched and green; they migrate opportunistically later.
7. **Naming**: **Browser Tabs Gateway** — already recorded in `CONTEXT.md` (commit `65a90ab`).

Gateway operations (browser vocabulary): `queryAllTabs`, `getTab`, `getCurrentTab`, `removeTabs` (bulk with per-id fallback, returns removed count), `updateTab`, `createTab`, `createTabWithFallbackUrl`, `groupTabs` (guards optional `chrome.tabs.group`), `moveTab`, `getAllWindows`, `getCurrentWindow`, `focusWindow`, `createWindow`, `getRecentlyClosed`, `queryTabGroups`, `requestExternalUnsuspend`.

## Steps

1. **Commit A (wave 1)** — the seam, both adapters live:
   - `src/extension/browser-tabs-gateway.ts`: `ChromeTabsApi` type + per-call resolution + `setChromeTabsApi` + the ops above.
   - `tests/helpers/fake-chrome.mjs` + `.d.mts`: the factory.
   - `tests/browser-tabs-gateway.test.ts`: behavioral suite — per-call global resolution order, injection, never-throw normalization, create-fallback retry, `removeTabs` partial-failure count, `groupTabs` guard.
   - Fixture swap: convert the fixture's inline data script to `type="module"`, import the factory, replace the hand-rolled `window.chrome` (`:368-444`) with `createFakeChromeApi({...})`, keeping its scenario data and its `runtime.sendMessage` handler as injected config. `tabActivatedListeners.dispatch(...)` becomes the api object's event `dispatch`.
2. **Commit B (wave 2)** — `tabs.ts` and `tab-actions.ts` call the gateway only; extract `live-tab-matching.ts` (pure) from the three duplicated blocks with a decision-table suite (exact URL, effective URL, suspended raw URL, folded same-title variants, grouped/pinned exclusions).
3. **Commits C+ (wave 3)** — `undo.ts`, `tab-focus.ts` (its `ChromeTabFocusApi` dissolves into the shared type), `tab-move.ts` (same), `groups.ts` (`queryTabGroups`), `closed-tabs.ts` (`getRecentlyClosed`); one or two modules per commit.

## Boundaries

- Do NOT touch `app.tsx`'s event-listener block, `suspension.ts`/`local-config.ts` (storage seam), background services, or bookmark/history sources.
- Do NOT move matching/dedupe/suspend policy into the gateway — it stays in Tab Actions.
- Do NOT rewrite the 21 existing `globalThis`-patching test files.
- Do NOT remove `export let openTabs` (candidate 5's move).
- If cited line anchors have drifted from commit `65a90ab`, re-locate before editing; STOP if the shape has materially changed.

## Verification

- `pnpm verify` green after every commit; `pnpm build` + stage `extension/dist` with each.
- Wave 1: gateway suite passes twice — once via `setChromeTabsApi(createFakeChromeApi(...))`, once via `globalThis.chrome` patching (proving both adapter paths).
- Fixture boot: `pnpm serve`, open `tests/fixtures/dashboard-resize.html`, dashboard renders with the factory-built fake (cards visible, no console errors).
- After wave 2: `RUN_BROWSER_SMOKE=1 pnpm test:browser` once (the fixture's fake now mutates state on remove/update — real behavior, previously no-ops).
- **Done when**: no module outside `browser-tabs-gateway.ts` calls `chrome.tabs/windows/tabGroups/sessions` except `app.tsx` events + excluded modules; matcher suite covers the decision table; all waves committed.
