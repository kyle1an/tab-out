# 003 — Replace `transition-all` on live buttons with explicit property lists

- **Status**: DONE (commit `61562e3`)
- **Commit**: 14757f3
- **Severity**: MEDIUM
- **Category**: Performance / feel
- **Estimated scope**: 3 files, 4 single-line class edits

## Problem

`transition: all` animates every mutating property — off-GPU layout properties if they ever change, and, concretely today, focus indicators: on the tabs trigger the `focus-visible` ring (a box-shadow) fades in over the transition duration, so keyboard focus feedback arrives late. Keyboard-driven feedback should be instant. Explicit property lists also make the intended motion legible.

Current code (the four live sites):

```tsx
// src/components/HeaderStats.tsx:58 — header action button; hover changes border-color + text color
className="action-btn inline-flex h-(--header-control-height) box-border cursor-pointer items-center gap-[5px] rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card px-3 py-[5px] font-[inherit] [font-size:var(--header-control-font-size)] leading-(--header-control-line-height) font-medium text-tab-muted transition-all duration-200 [corner-shape:squircle] hover:border-tab-ink hover:text-tab-ink"
```

```tsx
// src/components/HeaderStats.tsx:81 — close-tabs button; hover changes border-color + background
className="action-btn close-tabs ... font-medium text-(--accent-amber) transition-all duration-200 [corner-shape:squircle] hover:border-(--accent-amber) hover:bg-[rgba(82,82,82,0.1)]"
```

```tsx
// src/components/DomainCard.tsx:101 — dedupe/action button; hover changes border-color + text color
'action-btn inline-flex h-[22px] box-border cursor-pointer items-center gap-[5px] rounded-[10px] border border-(--warm-gray) bg-tab-card px-3 py-0 font-sans text-[12px] font-medium tabular-nums text-tab-muted transition-all duration-200 [corner-shape:squircle] hover:border-tab-ink hover:text-tab-ink [&.closing]:...',
```

```tsx
// src/components/ui/tabs.tsx:45 — TabsTrigger baseline (used by the header source switch via HeaderBar.tsx:5);
// includes focus-visible:ring-[3px] — the ring currently fades in with transition-all
"relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full ..."
```

## Target

Each site transitions exactly the properties its states change; focus rings and selection shadows snap:

- `HeaderStats.tsx:58`: `transition-all` → `transition-[color,border-color]`
- `HeaderStats.tsx:81`: `transition-all` → `transition-[color,border-color,background-color]`
- `DomainCard.tsx:101`: `transition-all` → `transition-[color,border-color]` (its `[&.closing]:transition-opacity` override already handles the exit)
- `ui/tabs.tsx:45`: `transition-all` → `transition-[color]` (text color on hover/active; ring and active shadow snap — intended)

Durations and timing functions stay exactly as they are at each site — this plan changes property lists only.

## Repo conventions to follow

- The repo already prefers explicit lists elsewhere — exemplar: `src/components/WorkingSetPanel.tsx:367` uses `transition-[opacity,color,background]`, and `tests/working-set.test.ts:361` pins that style of list.
- Class edits happen inside quoted class strings; change only the named segment, keep everything else byte-identical.
- Commits: conventional-commit format, with the repo's `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

## Steps

1. **`src/components/HeaderStats.tsx:58`** — replace `transition-all duration-200` with `transition-[color,border-color] duration-200`.
2. **`src/components/HeaderStats.tsx:81`** — replace `transition-all duration-200` with `transition-[color,border-color,background-color] duration-200`.
3. **`src/components/DomainCard.tsx:101`** — replace `transition-all duration-200` with `transition-[color,border-color] duration-200`.
4. **`src/components/ui/tabs.tsx:45`** — replace `transition-all` (single token, no duration follows it in this string) with `transition-[color]`.
5. Run `pnpm build` and stage `extension/dist` together with the source edits.

## Boundaries

- Do NOT touch `src/components/ui/button-variants.ts:4` — it also has `transition-all`, but `ui/button` has no importers today (dead template code); leave it for whoever wires it up.
- Do NOT touch `src/components/ui/input.tsx` / `ui/select.tsx` (`transition-colors` is already an explicit list; `tests/build-pipeline.test.ts:525` pins the select trigger string).
- Do NOT change any duration, easing, hover color values, or markup.
- No new dependencies. If a quoted segment doesn't match (drift since commit 14757f3), STOP and report.

## Verification

- **Mechanical**: `pnpm verify` passes. Watch `tests/layout.test.ts:289` (pins other `action-btn` utilities in HeaderStats — unaffected if only the named segment changed).
- **Feel check**: load the unpacked `extension/` in Chrome (or `pnpm serve` → `extension/index.html`):
  - Tab through the header with the keyboard: focus rings on the source-switch options appear **instantly** (no fade-in).
  - Hover the header stats buttons and a card's dedupe badge: border/text/background fades look identical to before (200ms).
  - Click between Tabs/Bookmarks/History sources: the active option's text color still eases; nothing else visibly changed.
- **Done when**: no `transition-all` remains in `src/components` outside `ui/button-variants.ts`, hover feel is unchanged, focus rings snap, `pnpm verify` green, dist staged.
