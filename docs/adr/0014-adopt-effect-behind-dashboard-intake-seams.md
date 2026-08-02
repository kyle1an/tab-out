# ADR 0014: Adopt Effect Behind Async Ownership Seams

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
- Continue outside Dashboard Intake only where one module already owns a
  complete concurrency or resource lifecycle. The native-tab highlight
  controller qualifies because it serializes and coalesces browser reads and
  mutations while preserving user-owned native selections.
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

The second slice moves the serialized latest-wins Dashboard refresh flight
behind a named Effect operation and names the source-switch operation with
`Effect.fn`. It adds 11,621 raw bytes (3,496 deterministic gzip bytes), bringing
the app entry to 828,138 bytes; the background worker remains unchanged. The
runner still exposes one shared Promise, allows only one fetch at a time, drops
overtaken results and failures, and applies only the newest trailing request.

The third slice moves recently-closed intake into a scoped `FiberHandle`.
Replacing or stopping that workflow now interrupts its owned delay/read fiber,
cancels pending timers, and releases the Chrome subscription through scope
finalization. It adds 5,321 raw bytes (1,767 deterministic gzip bytes), bringing
the app entry to 833,459 bytes; the background worker remains unchanged.

The fourth slice moves the complete native-tab highlight reconciliation flight
behind named Effect operations and a typed browser-error channel while keeping
its serialized Promise boundary. It adds 553 raw bytes (227 deterministic gzip
bytes), bringing the app entry to 834,012 bytes; the background worker remains
unchanged.

The fifth slice replaces the manual Promise tail for Domain Card, section, and
Page Chip pin transactions with an Effect `Semaphore`. One named operation now
owns normalization, the cross-page Web Lock, read-modify-write persistence, and
typed failure recovery. It adds 1,570 raw bytes (429 deterministic gzip bytes),
bringing the app entry to 835,582 bytes; the background worker remains
unchanged.

The sixth slice moves the complete Saved Pages read-modify-write transaction
behind an Effect `Semaphore`, including malformed-state rejection, the
cross-page Web Lock, metadata conflict checks, persistence, and typed failure
recovery. The page-only fetch and mutation modules are separated from the
shared render and Saved Pages model so the startup-snapshot worker does not
import Effect accidentally. It adds 691 raw bytes (305 deterministic gzip
bytes), bringing the app entry to 836,273 bytes. The cleaner entry boundary
also removes 1,129 raw bytes (425 deterministic gzip bytes) of unused page code
from the worker, bringing it to 241,738 bytes while keeping it Effect-free.

The seventh slice replaces the closed-history dismissal Promise tail with an
Effect `Semaphore`. Its named transaction owns the cross-page Web Lock,
timestamp pruning, dismiss/Undo conflict checks, persistence, and typed failure
recovery. It adds 472 raw bytes (165 deterministic gzip bytes), bringing the
app entry to 836,745 bytes; the background worker remains unchanged.

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
