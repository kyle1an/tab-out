# Debugging the dashboard locally

The dashboard is a Chrome extension page, but you can run and debug it in a
plain browser with **fake tab data** — no extension reload loop, no real Chrome
APIs. This is the fastest way to inspect intricate UI such as page-chip hover
expansion.

## Run it

```sh
pnpm build      # build extension/dist (the fixture loads the built bundle)
pnpm serve      # static server on http://127.0.0.1:8765 (override with PORT=…)
```

Then open:

```
http://127.0.0.1:8765/tests/fixtures/dashboard-resize.html
```

`tests/fixtures/dashboard-resize.html` mocks `window.chrome` with a fixed set of
fake tabs — including single-line `… - JIRA` chips, suppression-marker chips, and
folded / title-variant groups — and loads `extension/dist/app.js`. Rebuild
(`pnpm build`) after editing `src/`; the fixture always loads the built `dist`.

## Measure, don't guess

The page-chip / title expansion-width logic in `src/components/PageChip.tsx`
(`getPageChipExpansionGeometry`, `getExpandedPageChipContentWidth`) is intricate.
Reason about it by **measuring the live DOM**, not by eye:

- Hover a `.page-chip`, then read its `getBoundingClientRect()` and the
  `--page-chip-expanded-width` custom property to see how far it actually grew.
- Compare against the chip's resting width and the content's one-line natural
  width to decide whether a given expansion is correct.

Driving the page with an automation browser (Playwright, Chrome DevTools MCP,
etc.) lets you hover and measure programmatically instead of guessing at the
layout math.

## Automated version

`tests/browser-resize-smoke.test.ts` (run with `pnpm test:browser`) is the
automated form of the same idea: it serves the repo, loads the fixture in
headless Chrome, and asserts on layout / expansion behavior.
