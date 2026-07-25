# ADR 0004: Pre-App Shell Stays A Static Stand-In

- Status: Superseded by ADR 0005
- Date: 2026-07-25

## Context

`extension/index.html` is generated from JSX at build time so the pre-app filter
shell is declared once and shares its class contract with the React header
through `src/lib/filter-input-classes.ts`. That removed the duplicated class
strings but not the duplicated structure. The shell renders a *replica* of the
Tabs-source header geometry, and `createRoot` discards it on mount.

The natural next step is to prerender the real header and hydrate it, which is
what an SSR-shaped app would do. It was specified and costed in
`.scratch/ssr-shell-hydration/`.

The payoff is concrete. The boot input and the real input become the same DOM
node, so three of the four handoff mechanisms disappear: the explicit re-focus in
`HeaderBar`, its `autoFocus`, and the two-frame suppression of the focus-ring
re-fade (`filterFocusHandoffPending`). Only the typed-value bridge would remain,
because build time cannot know the URL's `filter` param.

The cost is equally concrete. Hydration needs a synchronous mount whose first
render matches the HTML, so the four serial storage reads in `initializeApp()`
must move behind the mount. The shell must survive rather than be removed, which
grows the static HTML to the full header plus an Activation History skeleton and
makes an ordinary new-tab open paint a skeleton it does not paint today. And it
converts `CONTEXT.md` rule 131's single-commit startup guarantee from a property
of the code's shape — nothing renders until the snapshot exists — into a rule the
code must actively uphold.

## Decision

- Keep the pre-app shell a static stand-in rendered by `renderToStaticMarkup`.
  That is the correct renderer for static output which is not hydrated; the
  hydration-compatible `react-dom/static` entry points are not needed here.
- Keep `src/lib/filter-input-classes.ts` as the only sanctioned seam between the
  shell and the React header. It owns class strings and placeholder text. Do not
  widen it to carry startup state or layout structure.
- Do not extract a shared layout-frame component for the grid, main, and
  pinned-top wrappers. The two sides express the same geometry with different
  utilities — `col-start-2` against `col-2`, `py-3` against `pt-[12px] pb-[12px]`,
  `-ml-14 pl-14` against the `--header-shadow-left-reserve` pair. Normalizing them
  to one expression changes the app's own header classes and hands the shell
  `.dashboard-shell`, `.dashboard-main`, and `.pinned-top`, which `base.css` uses
  to attach the scroll-triggered header shadow and the `--dashboard-scrolled`
  trigger scope. That concentrates risk in the geometry the shell exists to hold
  still, and removes no behavior.
- Accept the four-mechanism focus handoff as the price of the stand-in.

## Consequences

The shell and the header are kept in agreement partly by test and partly by hand.
`tests/layout.test.ts` guards the input class contract, the placeholder, and the
grid-column template. It does not guard the `dashboard-main` or `pinned-top`
wrapper equivalence, so a padding, margin, or column change in `DashboardShell`
can silently desynchronize the shell. Real-Chrome inspection with `focusFilter=1`
is the only check that catches it. Treat header geometry edits as touching both
files.

An ordinary new-tab open continues to paint nothing until `app.js` runs. The
prerendered shell only becomes visible under `focusFilter=1`; otherwise
`filter-focus-boot.ts` removes it.

## Reopening this decision

Hydration becomes the better trade only when all of the following are true.

- A hydrated, pre-focused input demonstrably keeps focus, caret position, and its
  painted focus ring with no replacement suppression logic. **Satisfied
  2026-07-25.** Measured on the pinned Chromium against a development React
  build: the input and wrapper nodes survive, focus and value survive, the caret
  survives, and the focus ring runs one uninterrupted fade instead of the snap
  from 0.19 to full opacity that `filterFocusHandoffPending` produces today.
  Hydration also fixes a caret reset to end-of-text that ships today.
- A build-time render of the real header provably matches the client's first
  render, including `useId` values inside the Base UI `Tabs`, with a resolved
  answer for the placeholder that `historyRange` cannot supply at build time.
  **Satisfied 2026-07-25.** `useId` agreed (`_R_1_` both sides), and `HeaderBar`
  and `TabHistoryPanel` both prerender in Node with no browser and no `chrome.*`.
  The placeholder resolves by prerendering *and* first-rendering from
  `DEFAULT_HISTORY_RANGE`, then applying the stored preference as a post-hydration
  update — necessary because React does not patch mismatched attributes, so a
  disagreeing first render would persist the wrong placeholder permanently.
- A rewrite of `CONTEXT.md` rules 131, 133, and 134 is agreed in advance, since
  splitting mount from the startup commit changes a durable behavior contract.
  **Satisfied 2026-07-25.** The replacement wording was approved before the
  implementation began; it distinguishes React attaching from live-data
  hydration and preserves the one-update content guarantee.

Evidence and the implementation plan live in `.scratch/ssr-shell-hydration/`.
ADR 0005 records the resulting implementation and supersedes this decision.

Do not re-propose sharing a layout frame as an incremental step toward this. It
carries the geometry risk without the payoff, and hydration makes it unnecessary
by leaving one component instead of two.

## References

- Design and gating tickets: `.scratch/ssr-shell-hydration/`
- Startup and shell contracts: [`CONTEXT.md`](../../CONTEXT.md) rules 131, 133, 134
- [`renderToStaticMarkup`](https://react.dev/reference/react-dom/server/renderToStaticMarkup) — explicitly not for markup that will be hydrated
- [`react-dom/static` `prerender`](https://react.dev/reference/react-dom/static/prerender) — the hydration-compatible static renderer, available in the pinned React 19.2.7
