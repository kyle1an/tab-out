# Plans

Two waves so far: the animation audit (001-004, executed) and the architecture grilling (005-008).

## Architecture wave — grilled 2026-07-12 at `65a90ab`

| # | Plan | Strength | Status |
| --- | --- | --- | --- |
| 005 | [Browser Tabs Gateway](005-browser-tabs-gateway.md) | Strong | DONE (`3db7cb6` · `e62cbeb` · `73f71a0`) |
| 006 | [One FLIP move module](006-move-animation-module.md) | Worth exploring | DONE (`cd460ef`) |
| 007 | [Suppression tones into the view-model](007-suppression-tones-view-model.md) | Worth exploring | DONE (`31fc77c`) |
| 008 | [Title Expansion measurer](008-title-expansion-measurer.md) | Worth exploring | RETIRED — convergence rejected on contact; ADR-0002 |

Execution order was **005 (three waves) → 006 → 007 → 008**. 008 stopped at its own boundary: the premise failed the deletion test during implementation (the shared engine already lives behind the seam; what differs is per-surface policy). Candidate 5 (dashboard snapshot assembly) remains **deferred**: re-grill now that 005-006 have landed; its opening move (relocating the `openTabs` cache out of `tabs.ts`) is staged by 005's decision 3. The `Browser Tabs Gateway` and live-tab matching vocabulary is in CONTEXT.md.

# Animation improvement plans

Written by the `improve-animations` audit at commit `14757f3` (2026-07-12). Each plan is self-contained — an executor needs no other context. Full audit findings (including unplanned items) live in the audit conversation; unselected findings: popup enter/exit (menus/select dead `animate-in` classes), reduced-motion sweep (toast/tooltip/indicator), toast 500ms timing.

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Motion easing token + unify exit animations](001-motion-tokens-and-exit-sweep.md) | HIGH | DONE (`ac28415`) |
| 002 | [Fix mission-card transition list](002-mission-card-transition-list.md) | MEDIUM | DONE (`038fd4f`) |
| 003 | [Replace `transition-all` with explicit lists](003-remove-transition-all.md) | MEDIUM | DONE (`61562e3`) |
| 004 | [Source-switch indicator on the house curve](004-source-switch-indicator-curve.md) | MEDIUM | DONE (`9fa5606`) |

## Execution order

1. **001 first** — it defines the `--ease-swift` token in `src/styles/app.css` that 002 and 004 consume.
2. **002 and 004** in either order (both depend on 001; each includes an `ease-[cubic-bezier(0.2,0,0,1)]` fallback if run standalone).
3. **003** any time — fully independent.

All four touch disjoint class-string segments; 001/002/003 all edit `DomainCard.tsx` (different lines), so rebase rather than parallelize if executing concurrently.

## Shared execution notes

- After any source edit: `pnpm build`, stage `extension/dist` with the source change (the bundle is tracked; pre-commit runs `pnpm verify` including `verify:bundle`).
- Conventional-commit messages with the repo's `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.
- Feel checks: load the unpacked `extension/` dir in Chrome (new tab shows the dashboard), or `pnpm serve` and open `extension/index.html`. Slow motion via DevTools → Animations panel at 10%; reduced-motion via DevTools → Rendering → Emulate `prefers-reduced-motion`.
