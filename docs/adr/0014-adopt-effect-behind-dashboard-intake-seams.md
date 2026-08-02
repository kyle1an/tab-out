# ADR 0014: Adopt Effect Behind Dashboard Intake Seams

- Status: Accepted
- Date: 2026-08-02

## Context

Dashboard Intake owns several asynchronous page workflows whose correctness
depends on supersession, retry, cleanup, and typed failure handling. Those
workflows currently expose a compact Promise-and-subscription interface to
React, but their implementations use independent sequence counters and
manually managed asynchronous lifecycles.

Tab Out previously added Effect around individual Chrome storage reads and
writes. That adapter immediately converted each Effect back to a Promise, so
it enlarged the service-worker bundle without owning a meaningful workflow.
The adapter was removed. A new adoption must therefore begin at a deep module
whose existing interface can hide the Effect runtime from callers.

Effect 4 is still a beta. Its package and runtime interfaces may change before
the stable release, and the dashboard app and MV3 service worker are separate
build entries that cannot share one bundled runtime.

The build's fixed byte caps were repository growth heuristics, not Chrome
limits or measured UX thresholds. Extension assets load locally, and raw file
size is only an indirect proxy for the parse, compile, and execution costs that
matter to a frequently opened new-tab page.

## Decision

- Pin `effect` to the exact reviewed `4.0.0-beta.102` release. Do not use a
  range that can silently advance the beta during an install.
- Adopt Effect inside existing deep modules, one complete workflow at a time.
  Do not add Effect wrappers around isolated Promise calls.
- Begin with Dashboard Intake source switching. One Effect fiber owns each
  source-switch attempt, context-change retry, and final dispatch; a newer
  source choice interrupts the previous fiber.
- Keep that complete workflow in the app entry instead of introducing an
  asynchronous runtime-loader seam solely to satisfy a raw-byte threshold.
- Remove fixed bundle-size assertions from the build test. Continue recording
  bundle deltas for dependency decisions, while using startup and interaction
  measurements to judge runtime regressions.
- Preserve the `AppDashboardStore` interface and its `useSyncExternalStore`
  React adapter. Effect types do not enter components, JSX, reducers, view
  models, or layout and animation code.
- Keep browser and Chrome dependencies as Promise-based adapters at the seam.
  MV3 work that must survive service-worker termination continues to use
  persisted state and Chrome alarms rather than in-memory Effect schedules.
- Treat generated app and worker bundle changes as adoption evidence. Each
  additional Effect slice must pass the existing interface tests and justify
  its measured bundle cost before it is retained.

## Consequences

Dashboard Intake gains structured interruption and a typed failure channel
without changing its React-facing interface or product behavior. The first
slice adds 24,638 raw bytes (8,465 gzip bytes) to the app entry, bringing it to
816,517 bytes; the background worker remains byte-for-byte unchanged.
Contributors must understand the Effect workflow inside adopted modules even
though ordinary callers remain Promise-based.

Beta upgrades are deliberate dependency changes requiring focused review,
full verification, and fresh bundle measurements. Reaching Effect 4 stable is
an upgrade checkpoint, not automatic authority to expand Effect into other
modules. The background worker remains Effect-free until a separate workflow
proves enough leverage to pay for a second bundled runtime.

## References

- [ADR 0007](0007-one-dashboard-intake-seam-for-arriving-state.md) — the
  Dashboard Intake seam retained by this adoption
- [`CONTEXT.md`](../../CONTEXT.md) — dashboard startup and source-switch
  behavior that this internal migration preserves
