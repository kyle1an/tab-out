# 010 — Let React Compiler compile the per-chip hook (hoist three default params)

- **Status**: DONE (`b0ba829`)
- **Commit**: `119ec06`
- **Severity**: HIGH
- **Category**: Performance
- **Rule**: react-hooks-js/todo (React Compiler `Todo: lowerReorderableExpression` bailout)
- **Estimated scope**: 1 file (`src/components/PageChip.tsx`), ~15 changed lines

## Problem

`usePageChipElement` (`src/components/PageChip.tsx:904`) — the ~900-line hook
behind every rendered page chip, the hottest leaf in the app — **bails out of
React Compiler** with three `lowerReorderableExpression` diagnostics. The cause
is three default-parameter expressions the compiler cannot safely reorder
(default-value expressions that read refs or `chip.*` members). Each site
already carries a suppression comment acknowledging the bailout.

Because the hook is uncompiled, none of its derivations are memoized: the
`JSON.stringify` clamp key (`PageChip.tsx:931`), variant-close partitioning
(912-918), highlight-term derivation (923), and every callback identity are
recomputed on every chip render — and chips re-render on every hover
transition by design (they consume `HoverStateContext`,
`PageChip.tsx:906`). With N tabs open, that is N full uncompiled hook bodies
per hover. Compiling the hook makes those re-renders nearly free.

The canonical guidance for `react-hooks-js/todo` (fetched from react.doctor):
"Refactor the code into a shape the Compiler currently supports" — here,
moving the default-parameter expression into the function body. Semantics are
preserved exactly by an explicit `undefined` check (a default parameter applies
only when the argument is `undefined`).

The three sites:

```tsx
// src/components/PageChip.tsx:968-969 — current
// react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the logical-expression default param; behavior is correct, the compiler just can't reorder it.
const updateChipSlotMeasurements = useCallback((chipEl: HTMLElement | null = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null) => {
```

Call sites: `PageChip.tsx:1074` and `1077` pass `chipEl`; `PageChip.tsx:1292`
calls it with **zero arguments** — the body fallback must keep working for that
call.

```tsx
// src/components/PageChip.tsx:1087-1088 — current
// react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the default-param expression; behavior is correct, the compiler just can't reorder it.
async function focusChipUrl(targetUrl: string | undefined, sourceType = chip.sourceType, target?: Pick<DashboardChipData, 'rawUrl' | 'tabId'>) {
```

```tsx
// src/components/PageChip.tsx:1785-1786 — current
// react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the default-param expression; behavior is correct, the compiler just can't reorder it.
function structuralPlaceholderNode(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabel = chip.pathGroupLabel) {
```

Call site `PageChip.tsx:1915` passes `target.pathGroupLabel`, which may be
`undefined` at runtime — with a default parameter that falls back to
`chip.pathGroupLabel`, so the replacement must use an `=== undefined` check
(not `??` only if types allowed null; here both operands are
`string | undefined`, so semantics match either way — use `=== undefined` to be
exact).

## Target

```tsx
// site 1 — target (suppression comment removed)
const updateChipSlotMeasurements = useCallback((chipElArg?: HTMLElement | null) => {
  const chipEl = chipElArg !== undefined ? chipElArg : chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null
  const nextSize = roundedElementSize(chipEl)
  /* rest of the body unchanged, with `chipEl` referring to the new const */
```

```tsx
// site 2 — target (suppression comment removed)
async function focusChipUrl(targetUrl: string | undefined, sourceTypeArg?: DashboardChipData['sourceType'], target?: Pick<DashboardChipData, 'rawUrl' | 'tabId'>) {
  const sourceType = sourceTypeArg !== undefined ? sourceTypeArg : chip.sourceType
  /* rest of the body unchanged */
```

```tsx
// site 3 — target (suppression comment removed)
function structuralPlaceholderNode(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabelArg?: string) {
  const fallbackLabel = fallbackLabelArg !== undefined ? fallbackLabelArg : chip.pathGroupLabel
  const hiddenLabel = segment.label || fallbackLabel
  /* rest of the body unchanged */
```

Match the parameter type of `sourceTypeArg` to whatever `chip.sourceType`'s
type is in `src/components/types.ts` (the current signature's inferred type).

Remove the three `react-doctor-disable-next-line react-hooks-js/todo` comments
— they document exactly these bailouts and become stale once fixed. Do NOT
remove the two `react-doctor/exhaustive-deps` disable comments at
`PageChip.tsx:975` and `PageChip.tsx:1046` — those cover a different,
still-valid decision.

## Repo conventions to follow

- Two-space indent, no semicolons, single quotes; keep the existing
  `useCallback` deps arrays untouched.
- Naming: prefer the `*Arg` parameter rename shown above so the body-local
  const keeps the original name and the rest of the body needs zero edits.

## Steps

1. Apply the three signature/body edits above; delete their three suppression
   comments.
2. Save this verification script (uses only packages already in
   `node_modules`) as `/tmp/compiler-check.mjs` — do not commit it:

   ```js
   import { createRequire } from 'node:module'
   import { readFileSync } from 'node:fs'
   const repoRequire = createRequire('/Users/zenni/Developer/tab-out/package.json')
   const compiler = repoRequire('babel-plugin-react-compiler')
   let babel
   try { babel = repoRequire('@babel/core') } catch {
     babel = createRequire(repoRequire.resolve('@rolldown/plugin-babel'))('@babel/core')
   }
   const file = process.argv[2]
   const errors = []
   babel.transformSync(readFileSync(file, 'utf8'), {
     filename: file, babelrc: false, configFile: false, code: false,
     parserOpts: { plugins: ['typescript', 'jsx'] },
     plugins: [[compiler, { panicThreshold: 'none', logger: { logEvent(_f, e) {
       if (e.kind === 'CompileError') errors.push(`fn@${e.fnLoc?.start?.line}: ${e.detail?.reason ?? ''}`)
       if (e.kind === 'CompileSuccess') console.log(`compiled: ${e.fnName ?? '(anon)'}`)
     } } }]]
   })
   if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
   ```

3. Run `node /tmp/compiler-check.mjs src/components/PageChip.tsx`. **Before**
   this plan it prints three `fn@904` errors. **After**, it must exit 0 and the
   compiled list must include the function containing line 904
   (`usePageChipElement`) alongside `ChipFaviconFrame` and `PageChip`. If a NEW
   compiler error surfaces once lowering succeeds (validation runs only after
   lowering), STOP and report it — do not chase it with further refactors.

## Boundaries

- Only `src/components/PageChip.tsx`. No behavior changes, no dependency
  changes, no other bailouts in other files (they are covered by plans 009/011
  or are settled design).
- STOP if the code has drifted from commit `119ec06`.

## Verification

- **Mechanical**:
  - The compiler check script exits 0 for `src/components/PageChip.tsx` and
    reports `usePageChipElement` compiled.
  - `pnpm verify` passes (the react-doctor gate runs at `failOn: "error"`;
    the removed suppressions must not resurface diagnostics). Build output
    staged with the source change (`extension/dist` is tracked).
- **Behavior check** (unpacked extension or `pnpm serve` +
  `extension/index.html`):
  1. Chip measurements: hover a long-titled chip → the title expansion opens
     with correct width/lines (site 1 feeds expansion geometry; the zero-arg
     call at 1292 must still measure).
  2. Chip activation: click a chip for an open tab (focuses it), a history
     chip, and a bookmark chip (site 2 routes by `sourceType`) — all three
     still navigate correctly.
  3. Path-group chips: a chip with a structural `/` placeholder still shows
     the placeholder glyph collapsed and its label when expanded (site 3).
  4. React DevTools Profiler: hover across chips — per-chip render duration
     should visibly drop versus a pre-change profile (the hook's interior
     derivations are now memoized).
- **Done when**: compiler check is clean, `pnpm verify` is green, and the three
  chip behaviors above are unchanged.
