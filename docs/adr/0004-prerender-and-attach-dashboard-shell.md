# ADR 0004: Prerender And Attach The Dashboard Shell

- Status: Accepted
- Date: 2026-07-25

## Context

The generated dashboard page used to contain a hand-assembled filter shell that
`createRoot` discarded after serial startup reads completed. Keeping the replica
aligned with the real header required duplicated structure, an explicit focus
transfer, `autoFocus`, and a two-frame focus-transition suppression. It also
reset a pre-app caret to the end of the input.

Prototype measurements established that `hydrateRoot` preserves the focused
input node, selection, typed value, and painted focus transition. A build-time
render of the real component tree also matched the client's first render,
including Base UI ids. The remaining mismatch hazard was async-derived props:
React does not repair disagreeing first-render attributes, so stored values
cannot participate in the client's attaching render.

## Decision

- `src/index-html.tsx` prerenders `AppRoot` with `react-dom/static`'s
  `prerender`. Its output is the direct content of `#appRoot`, with no adjacent
  whitespace nodes.
- `src/app.tsx` calls `hydrateRoot` synchronously, before startup storage reads
  resolve. Recoverable hydration errors are logged as defects rather than
  suppressed.
- The server and client's attaching render both use build-time defaults. Before
  attachment, the classic boot script may seed the existing input's DOM value
  from the URL and buffer edits without changing that render tree. React-owned
  filter state, stored history range, cached dashboard data, and local pin state
  arrive only after attachment.
- Cached snapshot, local state, and history range cross one external startup
  boundary. The app applies them together before paint; dashboard, Activation
  History, Working Set, and recently closed rows remain one startup update.
- The generated shell is present on every dashboard load. The filter input is
  never placed behind a startup-data Suspense boundary, so filling the shell
  cannot replace it.
- The typed-value buffer remains because build time cannot know the page URL or
  what the user types before `app.js` parses. Once React reads it, the app removes
  the classic boot listener and releases the global value.

## Consequences

`extension/index.html` grows from roughly 4.3 KB to 16.4 KB, while the app bundle
remains roughly 759 KB. In exchange, the real header and reserved Activation
History column paint before the bundle or storage, the input remains one DOM
node through interactivity, and the structural replica is gone.

Top-level App changes now affect committed HTML as well as the client bundle.
The build test guards direct root content and browser tests guard node identity,
caret/focus continuity, an unpainted resting header shadow, History-off
placeholder correction, early interactivity, and atomic startup content.

The first-render-default rule is durable: any future stored value that affects
markup or attributes must begin at its build-time default and update after
attachment. The filter's pre-app DOM-value handoff must preserve the URL until
React adopts that intent. A mismatch must be fixed at its source;
`suppressHydrationWarning` is not an acceptable escape hatch.

## References

- Design, measurements, and implementation plan: `.scratch/ssr-shell-hydration/`
- Startup contract: [`CONTEXT.md`](../../CONTEXT.md)
