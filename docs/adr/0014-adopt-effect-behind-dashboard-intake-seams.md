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
- Use Effect Schema at valuable persisted-data and cross-context boundaries.
  Decode or validate unknown data once at the owner, preserve deliberate
  backward-compatible normalization, and keep Schema types out of UI code.
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

The eighth slice begins deliberate worker adoption at the Tab History service.
An Effect `Semaphore` now owns each complete history critical section across
startup reset barriers, browser reads and focus operations, canonicalization,
persistence, cache commits, and typed failure recovery. It adds 36,157 raw
bytes (12,344 deterministic gzip bytes), bringing the worker entry to 277,895
bytes; the app entry remains unchanged. This is intentionally an in-memory
ordering mechanism only: persisted history remains the recovery authority
across MV3 worker termination.

The ninth slice replaces the Working Set activity Promise tail with an Effect
`Queue` and per-operation `Deferred` results. One named drain preserves strict
offer order, so an activity read still waits for mutations that began first,
while each mutation owns its tab lookup, deduplication, read-modify-write
persistence, cache update, and in-memory signal commit. It adds 5,522 raw bytes
(1,597 deterministic gzip bytes), bringing the worker entry to 283,417 bytes;
the app entry remains unchanged. Persisted activity remains the recovery
authority across MV3 worker termination.

The tenth slice extracts that strict FIFO drain as a shared Effect serializer
and adopts it for startup-snapshot cache mutations. A named operation now owns
the complete cross-context Web Lock, session and durable reads, generation
comparison, Working Set priority rebase, dual writes or promotion, checkpoint
scheduling, and typed failure recovery. It adds 4,736 raw bytes (1,450
deterministic gzip bytes), bringing the app entry to 841,481 bytes. Reusing the
Working Set serializer adds 20 raw bytes (63 deterministic gzip bytes),
bringing the worker entry to 283,437 bytes. Session and durable storage remain
the recovery authorities across MV3 worker termination.

The eleventh slice moves the toolbar badge's complete latest-wins refresh loop
behind named Effect operations and typed browser-read and presentation-write
failures. Burst coalescing still exposes one shared Promise to Chrome event
listeners, while the Effect workflow owns browser reads, supersession checks,
write deduplication, and retryable partial failures. It adds 1,001 raw bytes
while deterministic gzip size decreases by 145 bytes, bringing the worker
entry to 284,438 raw bytes and 94,852 deterministic gzip bytes; the app entry
remains unchanged.

The twelfth slice moves the startup-snapshot service's complete rebuild flight
behind named Effect operations and a typed refresh failure. The workflow owns
cache seeding, concurrent service and storage reads, stale-session rejection,
snapshot construction, persistence, and recovery after an unexpected failure;
its event-facing shared Promise and trailing-debounce contract remain stable.
It adds 411 raw bytes and 97 deterministic gzip bytes, bringing the worker
entry to 284,849 raw bytes and 94,949 deterministic gzip bytes; the app entry
remains unchanged. Short in-memory debounce and restore-settle timers remain
plain event-registration state, while Chrome alarms remain the durable MV3
schedule.

The thirteenth slice brackets the complete recently-closed restore lifecycle
with Effect acquire/use/release. Acquisition arms the page-local suppression
marker and awaits the worker acknowledgement before Chrome can restore;
release always clears that marker, publishes the finite settle window, notifies
page consumers, and broadcasts settlement after success or failure. It adds
561 raw bytes and 204 deterministic gzip bytes to the app entry, bringing it
to 842,042 raw bytes and 265,590 deterministic gzip bytes. The shared module
adds 1,137 raw bytes and 314 deterministic gzip bytes to the worker entry,
bringing it to 285,986 raw bytes and 95,263 deterministic gzip bytes.

The fourteenth slice moves the complete Undo restore state machine behind
named Effect operations. A bracket now owns the `restoring` guard, tabs are
recreated sequentially in tab-strip order, partial failures remain retryable,
group restoration stays best-effort, and delayed Switch actions revalidate the
restored tab identity before activation. It adds 743 raw bytes and 177
deterministic gzip bytes, bringing the app entry to 842,785 raw bytes and
265,767 deterministic gzip bytes; the worker entry remains unchanged.

The fifteenth slice moves the complete Saved Pages action workflows behind
named Effect operations and typed mutation and refresh failures. Save, remove,
and toast Undo still expose Promise callbacks to the UI, while each workflow
owns persistence, dashboard refresh, and the existing user-feedback branches.
It adds 565 raw bytes and 130 deterministic gzip bytes, bringing the app entry
to 843,350 raw bytes and 265,897 deterministic gzip bytes; the worker entry
remains unchanged.

The sixteenth slice moves each native placement protocol request behind a
named Effect operation and typed browser-operation failure. The workflow owns
validation, profile-window inventory, placement, and normalized native-host
responses. It adds 253 raw bytes and 92 deterministic gzip bytes, bringing the
worker entry to 286,239 raw bytes and 95,355 deterministic gzip bytes; the app
entry remains unchanged. Native-port reconnection keeps its callback and
`setTimeout` backoff because Chrome owns the port lifetime and an MV3 worker
may terminate between attempts.

The seventeenth slice moves app bootstrap behind a named Effect operation and
typed startup-read failures. Immediately-started child fibers preserve the
eager history-preference and current-page reads while the parent retains cache
then local-state ordering, joins both reads, rebases a cached snapshot, and
publishes one atomic startup update. It adds 929 raw bytes and 264 deterministic
gzip bytes, bringing the app entry to 844,279 raw bytes and 266,161
deterministic gzip bytes; the worker entry remains unchanged.

The eighteenth slice moves the page-side startup snapshot coalescer behind a
named Effect operation and typed fetch failure. Same-key callers still share
one Promise, distinct keys may run concurrently, and an Effect finalizer now
releases only the flight it owns after success or failure. It adds 250 raw
bytes and 38 deterministic gzip bytes, bringing the app entry to 844,529 raw
bytes and 266,199 deterministic gzip bytes; the worker entry remains unchanged.

The nineteenth slice begins a separate Effect Schema boundary track at the
versioned startup cache. Declarative schemas now validate the cache envelope,
Dashboard data, local state, and render-ready view model in both extension
contexts. The hot cache check preserves the original Dashboard object for
first paint, legacy partial Activation History and Working Set records still
flow through their normalizers, legacy recently-closed rows receive explicit
defaults, malformed optional Dashboard fields are rejected, and derived Domain
Card IDs are still repaired. This removes the duplicated hand-written shape
guards and their unsafe view-model casts. Loading Schema adds 32,941 raw bytes
and 10,927 deterministic gzip bytes to the app entry, bringing it to 877,470
raw bytes and 277,126 deterministic gzip bytes. Because startup cache ownership
is shared, it also adds 33,484 raw bytes and 10,912 deterministic gzip bytes to
the worker entry, bringing it to 319,723 raw bytes and 106,267 deterministic
gzip bytes. The focused first-paint cache test remains in the low-single-digit
millisecond range.

The twentieth slice validates the worker-to-page Dashboard service-state
response with Effect Schema before it can replace known page state. The schema
requires a successful atomic response, compatible Activation History and
Working Set envelopes, and structurally valid serialized Chrome tab and window
rows. Those browser rows are normalized into complete internal inputs at the
boundary, while the existing history and activity normalizers retain their
repair and pruning policies. This removes the response guards and casts from
the consumer. It adds 2,092 raw bytes and 613 deterministic gzip bytes to the
app entry, bringing it to 879,562 raw bytes and 277,739 deterministic gzip
bytes. The shared normalizer cleanup adds 94 raw bytes and 27 deterministic
gzip bytes to the worker entry, bringing it to 319,817 raw bytes and 106,294
deterministic gzip bytes.

The twenty-first slice replaces the native placement host protocol's manual
record, identifier, timestamp, coordinate, dimension, and bounds guards with
Effect Schema checks. Validation remains staged so callers keep the existing
specific rejection reasons for non-object messages, unsupported versions,
invalid request IDs, expired requests, unsupported request types, invalid
operations, and invalid target bounds. The placement operation still receives
only a fully validated bounds value. The app entry remains unchanged. It adds
2,476 raw bytes and 687 deterministic gzip bytes to the worker entry, bringing
it to 322,293 raw bytes and 106,981 deterministic gzip bytes.

The twenty-second slice centralizes the internal runtime-message protocol and
validates it with Effect Schema in both extension contexts. Closed-restore
state now requires a non-empty identifier, a known phase, and a boolean
settlement result when present; malformed claimed restore messages retain the
worker's explicit rejection response. Activation History keeps its legacy
missing-or-invalid direction fallback while successful worker responses must
carry a real boolean success marker and an entries array before normalization.
This removes the remaining casts and ad hoc guards from those message owners.
It adds 565 raw bytes while deterministic gzip size decreases by 489 bytes,
bringing the app entry to 880,127 raw bytes and 277,250 deterministic gzip
bytes. It adds 375 raw bytes while deterministic gzip size decreases by 21
bytes, bringing the worker entry to 322,668 raw bytes and 106,960 deterministic
gzip bytes.

The twenty-third slice validates the versioned Saved Pages storage envelope
and candidate records with Effect Schema. A missing key remains a valid empty
first-run store, an invalid version or pages container still fails the read,
and a valid envelope continues to repair compatible legacy metadata while
dropping malformed individual records. The storage owner no longer reaches
unknown data through `Partial` casts. Schema and Chrome I/O live in a dedicated
storage-boundary module so the shared Saved Pages model remains Effect-free.
It adds 582 raw bytes and 172 deterministic gzip bytes to the app entry,
bringing it to 880,709 raw bytes and 277,422 deterministic gzip bytes. Because
the worker also reads Saved Pages for startup snapshot composition, it adds 573
raw bytes and 156 deterministic gzip bytes to the worker entry, bringing it to
323,241 raw bytes and 107,116 deterministic gzip bytes.

The twenty-fourth slice validates the page-owned closed-history dismissal map
with Effect Schema. The boundary now rejects non-record containers without a
cast, accepts only non-empty keys and finite timestamps, and still prunes
invalid or expired entries independently so one bad value cannot hide valid
dismissals. It adds 17 raw bytes and 48 deterministic gzip bytes to the app
entry, bringing it to 880,726 raw bytes and 277,470 deterministic gzip bytes;
the worker entry remains unchanged.

The twenty-fifth slice replaces Activation History v2's manual persisted-entry
and envelope guards with a concrete Effect Schema. Stack identities require
integer window and tab IDs plus a URL, pending identities additionally require
a finite creation timestamp, and the cursor remains an integer. Missing state
is still a valid first run, while the former ID-only format and malformed v2
records still reset before Chrome can reuse stale tab IDs. The validated value
now reaches canonicalization without a cast. The app entry remains unchanged;
removing the larger manual validator reduces the worker entry by 312 raw bytes
and 31 deterministic gzip bytes, bringing it to 322,929 raw bytes and 107,085
deterministic gzip bytes.

The twenty-sixth slice replaces the Working Set activity envelope, record, and
event guards with Effect Schema predicates shared by page and worker consumers.
The version and records container now validate once, while malformed records,
invalid events, and expired events are still removed independently; valid
siblings retain URL canonicalization, dismissal repair, and bounded event
history. The worker storage read no longer casts unknown data before this
normalizer. It adds 38 raw bytes and 10 deterministic gzip bytes to the app
entry, bringing it to 880,764 raw bytes and 277,480 deterministic gzip bytes.
It adds 17 raw bytes and 69 deterministic gzip bytes to the worker entry,
bringing it to 322,946 raw bytes and 107,154 deterministic gzip bytes.

The twenty-seventh slice validates the persisted suspender target and its
cross-context observation generation with Effect Schema. Non-empty extension
identifiers and URL templates remain readable without generation metadata for
legacy compatibility, while only a complete target with a finite `observedAt`
may suppress a newer write. Live tab discovery, cache revision protection, and
the origin-wide Web Lock continue to own ordering. Removing the manual object
casts reduces the app entry by 63 raw bytes while deterministic gzip size adds
27 bytes, bringing it to 880,701 raw bytes and 277,507 deterministic gzip
bytes. It reduces the worker entry by 70 raw bytes while deterministic gzip
size adds 26 bytes, bringing it to 322,876 raw bytes and 107,180 deterministic
gzip bytes.

The twenty-eighth slice validates the Dashboard's three-key local pin snapshot
with one Effect Schema before it can replace warm UI state. Each key may still
be absent on first run, and valid arrays continue through the existing domain,
section, and Page Chip repair functions; a non-array value for any key still
fails the atomic read instead of clearing known pins. Explicit `undefined`
properties from compatible storage adapters remain equivalent to absent keys.
It adds 260 raw bytes and 46 deterministic gzip bytes to the app entry,
bringing it to 880,961 raw bytes and 277,553 deterministic gzip bytes. The
shared startup-snapshot reader adds 255 raw bytes and 62 deterministic gzip
bytes to the worker entry, bringing it to 323,131 raw bytes and 107,242
deterministic gzip bytes.

The twenty-ninth slice validates the persisted history-range preference with
an Effect Schema literal set on both reads and writes. Unknown strings and
non-string storage values retain the one-day fallback, and the existing Web
Lock continues to preserve cross-page write order. The schema and Chrome I/O
live in a dedicated storage-boundary module so the options module shared with
the lazy selector stays Effect-free and the established chunk graph remains
stable. It adds 65 raw bytes and 25 deterministic gzip bytes to the app entry,
bringing it to 881,026 raw bytes and 277,578 deterministic gzip bytes; the
worker entry remains unchanged.

The thirtieth slice replaces the page-side Activation History and Working Set
snapshot record guards with Effect Schema predicates. Both snapshot containers
must carry an items array before normalization; Activation History preserves
its legacy field-by-field defaults, while Working Set continues to drop only
rows without integer tab and window identities or usable keys and URLs. This
removes the remaining ad hoc object guards from the nested worker-payload
normalizers without making one malformed optional field discard a repairable
row. It adds 624 raw bytes and 236 deterministic gzip bytes to the app entry,
bringing it to 881,650 raw bytes and 277,814 deterministic gzip bytes. Shared
module reachability adds 543 raw bytes and 141 deterministic gzip bytes to the
worker entry, bringing it to 323,674 raw bytes and 107,383 deterministic gzip
bytes.

The thirty-first slice shares the Dashboard local-pin value schema with live
`chrome.storage.onChanged` reconciliation. Initial reads and cross-page updates
now accept the same absent-or-array shape before the existing pin normalizers
apply domain-specific repair, while malformed event values continue to leave
known UI state untouched. Consolidating the guard reduces the app entry by 13
raw bytes and 30 deterministic gzip bytes, bringing it to 881,637 raw bytes and
277,784 deterministic gzip bytes. Shared-module minification reduces the worker
entry by 1 raw byte while adding 13 deterministic gzip bytes, bringing it to
323,673 raw bytes and 107,396 deterministic gzip bytes.

The thirty-second slice applies that same Effect Schema predicate inside each
pin mutation's locked read-modify-write transaction. A malformed outer storage
container now aborts before semantic normalization, mutation, or persistence,
so a user action cannot silently replace unknown stored data with a new list;
valid arrays still repair malformed individual identifiers as before. It adds
206 raw bytes and 52 deterministic gzip bytes to the app entry, bringing it to
881,843 raw bytes and 277,836 deterministic gzip bytes; the worker entry remains
unchanged.

The thirty-third slice extends Effect Schema to Chrome-support release tooling.
The committed policy, generated manifest, Playwright browser metadata, Google
VersionHistory response, and assembled cross-platform version map now cross
explicit schemas instead of record guards and type assertions. The existing
command-specific diagnostics and latest-two policy remain unchanged. This code
runs only in Node build and release checks, so both shipped extension entries
remain byte-for-byte unchanged.

The thirty-fourth slice validates the Tailwind language-server subprocess
protocol with Effect Schema. JSON-RPC envelopes, workspace-configuration
requests, published diagnostic locations, and nested settings records now
cross explicit schemas before the diagnostics client reads them. Malformed
messages fail with boundary-specific errors instead of reaching unchecked type
assertions, while the real language-server integration still reports zero
diagnostics. This code runs only in Node verification tooling, so both shipped
extension entries remain byte-for-byte unchanged.

The thirty-fifth slice validates the repository's commit-reference policy with
Effect Schema. The policy envelope and each custom-autolink entry now cross
layered schemas while preserving the existing top-level and indexed error
messages. Loading Schema adds roughly 0.2 seconds to the commit-message and
pre-push checks, an accepted tooling cost beside the commit hook's full
verification gate. This code does not enter either shipped extension entry.

The thirty-sixth slice moves the long-lived development build watcher behind
one scoped Effect workflow. A replaceable fiber owns debounce cancellation, a
sliding one-item queue preserves the existing single trailing build, and the
scope owns every native filesystem subscription plus the active `pnpm build`
child process. `SIGINT` and `SIGTERM` now close that scope, while typed watcher
and child-process failures remain recoverable at the workflow boundary. The
watched paths, native filesystem events, build reasons, and console reporting
remain unchanged. This code runs only through `pnpm dev`, so both shipped
extension entries remain byte-for-byte unchanged.

The thirty-seventh slice scopes the local dashboard debug HTTP server with
Effect. The workflow owns the listener and active connections from bind through
`SIGINT` or `SIGTERM`, reports invalid and occupied ports through one typed
error channel, and closes the server before its runtime settles. Request-level
fixture composition and static-file streaming remain native Node operations.
This server is developer and Playwright tooling only, so neither shipped
extension entry changes.

Beta upgrades are deliberate dependency changes requiring focused review,
full verification, and fresh bundle measurements. Reaching Effect 4 stable is
an upgrade checkpoint, not automatic authority to expand Effect into other
modules. The background worker paid for its separate Effect runtime only when
the Tab History critical section provided enough concurrency leverage.

## Audited Adoption Boundary

A repository-wide audit of Promise construction, async entry points, shared
in-flight state, queued work, timers, subscriptions, Web Locks, MV3 event
handlers, persisted values, runtime messages, native-host messages, JSON
parsing, and other unknown-data entry points found no further currently
worthwhile production Effect adoption seams. A follow-up tooling audit added
schemas where external release metadata and language-server messages justified
the boundary without entering shipped code, then identified the development
build watcher and local debug server as the two long-lived tooling workflows
with meaningful resource and interruption ownership.

Effect Schema now validates every extension-owned persisted-data envelope:
startup snapshots, Saved Pages, closed-history dismissals, Tab History,
Working Set activity, suspend targets, Dashboard pin snapshots and mutations,
and the history-range preference. It also validates every internal
cross-context protocol: runtime requests and responses, nested Activation
History and Working Set snapshots, and native placement host messages.
Validation remains intentionally layered: schemas establish the serialized
shape, while existing normalizers apply backward-compatible repair and product
semantics.

The remaining asynchronous code stays browser-native or Promise-based for
these reasons:

- Chrome, storage, dynamic-import, and snapshot-fetch modules are leaf adapters
  consumed by complete Effect workflows. Wrapping them separately would add
  nested runtimes without gaining ownership of concurrency or cleanup.
- Tab focus, move, activation, close, and dedupe commands intentionally return
  explicit complete, partial, failed, or unknown results and revalidate browser
  identity immediately before mutation. They have no shared resource lifecycle
  for Effect to own.
- History-range and suspension writers must acquire Web Locks at the browser
  observation boundary so page and worker contexts agree on ordering. An
  in-memory Effect queue cannot replace that cross-context authority.
- React optimistic revisions, storage subscriptions, DOM measurement,
  animation frames, visual-duration waits, and interaction debounce timers are
  UI lifecycle state. Effect types remain outside hooks, components, and layout
  controllers.
- Service-worker retry, restore-settle, native-port reconnect, and protocol
  watchdog timers are registration or recovery state tied to Chrome's MV3
  lifecycle. Durable recovery continues to use storage and Chrome alarms.
- Build generators and the Node test harness are finite tooling boundaries;
  adopting an Effect workflow or an Effect-specific test runner there would not
  exercise a runtime ownership seam. The development build watcher and local
  debug server are explicit exceptions: they remain active across work, own
  native subscriptions or a listening socket, and need interruption-safe signal
  cleanup. Schema remains appropriate for external metadata when it replaces
  unchecked parsing without entering shipped code.

The remaining manual value checks also stay outside Effect Schema:

- Domain, section, and Page Chip identifier parsing performs product-specific
  decoding, deduplication, and compatibility repair after the storage
  container has already crossed a schema boundary.
- Chrome tab, window, bookmark, session, resize-observer, and DOM values arrive
  through typed browser interfaces and are checked only where optional browser
  capabilities or overload shapes require a runtime branch.
- Source-select values, animation targets, layout hooks, and debug samples are
  local UI inputs. Moving their predicates to Schema would spread Effect into
  components or lazy UI chunks without strengthening a serialized boundary.
- The external suspender acknowledgment has only one contractual failure form,
  an `Error:` string; accepting every other response preserves compatibility
  with independently versioned extensions.
- Build generators and test fixtures are finite Node tooling with focused
  parsers and tailored diagnostics. They do not justify widening production
  adoption or replacing the Node test runner.

Future adoption therefore requires either a newly identified workflow that
owns meaningful concurrency, interruption, resource cleanup, or typed recovery,
or a new persisted or cross-context protocol. The presence of an `async`
function, `unknown` error cause, or local type guard alone is not a migration
reason.

## References

- [ADR 0007](0007-one-dashboard-intake-seam-for-arriving-state.md) — the
  Dashboard Intake seam retained by this adoption
- [`CONTEXT.md`](../../CONTEXT.md) — dashboard startup and source-switch
  behavior that this internal migration preserves
