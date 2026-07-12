# 001 — Add a motion easing token and unify all exit animations on it

- **Status**: DONE (commit `ac28415`)
- **Commit**: 14757f3
- **Severity**: HIGH
- **Category**: Cohesion & tokens / Easing & duration
- **Estimated scope**: 6 files, ~8 single-line class edits + 1 token addition

## Problem

Closing things (tabs, chips, rows, cards) is this product's core action, and the exit animations currently use four different timing recipes — three of them on the weak built-in CSS `ease`, while the app's signature curve everywhere else (FLIP moves, chip-close ghost) is the strong ease-out `cubic-bezier(0.2, 0, 0, 1)`. Side by side on one screen, a history row exits at 160ms weak-`ease`, a chip's ghost at 200ms strong curve, and a whole card at 250ms weak-`ease` shrinking to `scale(0.9)`. There is also no shared easing token — every value is hand-typed.

Current code (the exact class-string segments to change):

```tsx
// src/components/TabHistoryPanel.tsx:1318 — history row exit: 160ms, weak `ease`
'... [&.closing]:transition-[opacity,transform] [&.closing]:duration-160 [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.96)]',
```

```tsx
// src/components/DomainCard.tsx:455 — whole-card exit: 250ms, weak `ease`, deep scale(0.9), no reduced-motion guard
'... [&.closing]:transition-[opacity,transform] [&.closing]:duration-250 [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.9)]',
```

```tsx
// src/components/DomainCard.tsx:101 — dedupe/action button exit: weak `ease`
'... [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-[ease]',
```

```tsx
// src/components/PageChip.tsx:838 and :848 — favicon stack layers exit: weak `ease` (two identical segments)
'... [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-[ease]',
```

```tsx
// src/components/PageChip.tsx:1828 — chip title-row hover fill: ease-in-out starts slow on the app's most-hovered surface
mode === 'chip' && 'clickable cursor-default transition-[background,color,box-shadow] duration-150 ease-in-out hover:bg-neutral-600/[0.14] ...',
```

```tsx
// src/components/WorkingSetPanel.tsx:140 — exit ghost: correct curve, but hand-typed
'... motion-safe:transition-[opacity,transform] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.2,0,0,1)]',
```

## Target

One easing token, one exit recipe:

- New Tailwind v4 theme token in `src/styles/app.css`: `--ease-swift: cubic-bezier(0.2, 0, 0, 1);` (generates the `ease-swift` utility).
- Every class-driven exit: **200ms, `ease-swift`, exit scale `0.96`**, with `motion-reduce:[&.closing]:transform-none` so reduced-motion users keep the opacity fade but lose the movement (reduced ≠ zero).
- Hover **color** fades use CSS `ease` (per the easing decision order: entrances/exits → ease-out; hover/color → ease). So the chip hover fill changes `ease-in-out` → `ease-[ease]`, NOT to `ease-swift`.
- The working-set exit ghost keeps its 220ms duration (it is deliberately coupled to `WORKING_SET_ITEM_MOVE_MS = 220` in `src/extension/working-set-move-animation.ts:10` so the ghost fade and the sibling FLIP slide finish together) but switches to the token.

## Repo conventions to follow

- Tailwind v4 theme config lives in the `@theme` block of `src/styles/app.css` (lines 15–33). Theme keys in the `--ease-*` namespace automatically generate `ease-*` utilities, composable with variants (`[&.closing]:ease-swift`, `motion-safe:ease-swift`).
- The curve `cubic-bezier(0.2, 0, 0, 1)` is already the house style: `src/extension/working-set-move-animation.ts:151`, `src/extension/card-move-animation.ts` (280ms card FLIP), `src/components/PageChipCloseAnimation.ts:4`.
- The reduced-motion idiom to imitate: `src/components/PageChip.tsx:2276` ends with `[&.closing]:opacity-0 [&.closing]:[transform:scale(0.96)] motion-reduce:[&.closing]:transform-none`.
- Commits: conventional-commit format (`refactor(motion): …`), and in this repo every commit carries a `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

## Steps

1. **`src/styles/app.css`** — inside the `@theme` block (before the closing `}` at line 33), add:

   ```css
   /* Signature strong ease-out. The TS animators (PageChipCloseAnimation.ts,
      card-move-animation.ts, working-set-move-animation.ts) and the FLIP class in
      DomainCard.tsx pin this same curve as a literal, guarded by tests — keep in sync. */
   --ease-swift: cubic-bezier(0.2, 0, 0, 1);
   ```

2. **`src/components/TabHistoryPanel.tsx:1318`** — in the `history-entry-row` class string, replace
   `[&.closing]:duration-160 [&.closing]:ease-[ease]` with
   `[&.closing]:duration-200 [&.closing]:ease-swift`, and append
   ` motion-reduce:[&.closing]:transform-none` at the end of that quoted string (after `[&.closing]:[transform:scale(0.96)]`).

3. **`src/components/DomainCard.tsx:455`** — in the `domain-block` class string, replace
   `[&.closing]:duration-250 [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.9)]` with
   `[&.closing]:duration-200 [&.closing]:ease-swift [&.closing]:[transform:scale(0.96)] motion-reduce:[&.closing]:transform-none`.

4. **`src/components/DomainCard.tsx:101`** — in the `action-btn` class string, replace
   `[&.closing]:ease-[ease]` with `[&.closing]:ease-swift`.

5. **`src/components/PageChip.tsx:838` and `:848`** — in both `chip-favicon-stack-layer` class strings, replace
   `[&.closing]:ease-[ease]` with `[&.closing]:ease-swift` (two occurrences, identical edit).

6. **`src/components/PageChip.tsx:1828`** — in the chip-mode class string, replace
   `duration-150 ease-in-out` with `duration-150 ease-[ease]`.

7. **`src/components/WorkingSetPanel.tsx:140`** — in the `working-set-exit-ghost` class string, replace
   `motion-safe:ease-[cubic-bezier(0.2,0,0,1)]` with `motion-safe:ease-swift`. Keep `motion-safe:duration-[220ms]` as is.

8. Run `pnpm build` and stage `extension/dist` together with the source edits (repo discipline: the built bundle is tracked and `verify:bundle` diffs it).

## Boundaries

- Do NOT touch `src/components/PageChip.tsx:2276`'s `[&.closing]` block beyond what step 6 says about line 1828 — the page-chip row deliberately has **no** transition on `.closing`: a fixed-position ghost (`PageChipCloseAnimation.ts`) owns the visible fade while the real row snaps hidden and collapses via inline `max-height`/`padding` transitions.
- Do NOT change the FLIP arbitrary property `[.missions.is-packed_&.layout-moving.layout-moving-active]:[transition:transform_0.28s_cubic-bezier(0.2,0,0,1)]` in `DomainCard.tsx:455` — it is a move (not an exit) and is pinned verbatim by `tests/layout.test.ts:59`.
- Do NOT edit the TS animators' literal curve strings (`PageChipCloseAnimation.ts:4`, `working-set-move-animation.ts:151`, `card-move-animation.ts`) — `tests/working-set.test.ts:515` pins one verbatim; the token comment from step 1 records the coupling.
- Do NOT "fix" hover fades already on `ease-[ease]` (`HeaderBar.tsx:142`, `UrlPreview.tsx:14`, `DomainCard.tsx:461`) — hover/color → `ease` is correct.
- Do NOT add borders/outlines to any chip kind that lacks them (standing repo rule).
- No new dependencies. If any quoted segment above no longer matches (drift since commit 14757f3), STOP and report.

## Verification

- **Mechanical**: `pnpm verify` passes (typecheck, lint, react-doctor, build, `verify:bundle`, tests). No test currently pins `duration-160`, `duration-250`, `scale(0.9)`, or the chip-hover `ease-in-out`, so no test edits are expected — if one fails on these strings, update its pinned regex to the new string and say so.
- **Feel check**: load the unpacked `extension/` in Chrome (or `pnpm serve` and open `extension/index.html`), populate a few cards, then:
  - Close a single chip, a history row, and a whole card (card-actions menu → close). All three should now read as the same gesture: fast start, soft landing, ~200ms.
  - DevTools → Animations panel at 10% speed: the card close shrinks only slightly (0.96) — it should feel like the card "lets go", not "collapses into a point".
  - DevTools → Rendering → Emulate `prefers-reduced-motion: reduce`: closing a card or history row fades without scaling; chip close is instant (existing JS gate).
- **Done when**: all exits share 200ms/`ease-swift`/0.96 (except the documented 220ms working-set ghost), `pnpm verify` is green, and the built dist is staged with the source change.
