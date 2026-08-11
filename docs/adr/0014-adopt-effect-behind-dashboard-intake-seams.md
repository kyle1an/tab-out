# ADR 0014: Adopt Effect Behind Async Ownership Seams

- Status: Accepted
- Date: 2026-08-02
- Last reviewed: 2026-08-11

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

- Pin `effect` to the exact reviewed `4.0.0-beta.107` release. Do not use a
  range that can silently advance the beta during an install.
- Adopt Effect inside existing deep modules, one complete workflow at a time.
  Do not add Effect wrappers around isolated Promise calls.
- Use exactly one `ManagedRuntime` for the dashboard page and one for the MV3
  worker. Services compose inside those graphs; production modules do not call
  global Effect runners or create private runtimes.
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
- Put replaceable timers, retry fibers, queues, native subscriptions, and other
  long-lived resources in scoped services. Disposing an entry runtime must
  interrupt and finalize everything it owns.
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

The beta.107 checkpoint renames Effect Schema's typed error base from
`Schema.TaggedErrorClass` to `Schema.TaggedError`. Tab Out applies that
mechanical API migration across its existing error types without changing
their tags, payloads, ownership, or Promise-facing boundaries.

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

### Continued adoption after the first saturation audit

The first audit correctly identified the kinds of boundaries worth adopting,
but it treated the already-adopted modules as isolated Effect islands. A second
pass found additional leverage in joining those islands into one runtime per
extension entry, composing adjacent workflows without Promise round trips, and
letting scopes own the timers and subscriptions that belong to those services.
The continuation retained the same rule: a slice was kept only when it improved
workflow, resource, concurrency, validation, or recovery ownership.

| Slice | Commit | Retained boundary |
| --- | --- | --- |
| 38 | `ca8afec5` | Removed unchecked runtime assertions from existing Effect services and their page/worker consumers. |
| 39 | `2bb4958e` | Ran the Tailwind diagnostics subprocess through one typed, scoped Effect workflow. |
| 40 | `f5a13776` | Moved Chrome-support command dispatch and exit handling into a named Effect CLI workflow. |
| 41 | `209e12a6` | Made extension generation and the two Vite builds one ordered Effect build workflow. |
| 42 | `a351f609` | Moved the native-host round-trip harness to typed Effect process and protocol handling. |
| 43 | `f7f88b83` | Converged the watcher and debug server on the same tooling runtime boundary instead of ad hoc runners. |
| 44 | `a46c04a0` | Established the worker `ManagedRuntime` and moved Badge ownership into its service graph. |
| 45 | `1a8882a1` | Moved Working Set queue state and finalization into the shared worker runtime. |
| 46 | `a7ac2e83` | Moved Tab History serialization and service state into the shared worker runtime. |
| 47 | `d7d261ea` | Moved startup-snapshot cache and rebuild ownership into the shared worker runtime. |
| 48 | `cd93f308` | Scoped native-placement port messages and reconnect backoff to the worker runtime. |
| 49 | `761d9a05` | Established the page `ManagedRuntime` and its live `BrowserTabs` service. |
| 50 | `af1550e7` | Composed closed-tab restore and Undo browser operations inside the page runtime. |
| 51 | `b0456575` | Reused the page runtime for Saved Pages, pin, and dismissal storage transactions. |
| 52 | `0620246f` | Reused the page runtime for Dashboard Intake and native-tab highlight flights. |
| 53 | `7db3669e` | Composed Saved Page action, refresh, toast Undo, and metadata-healing workflows in that runtime. |
| 54 | `33aa527f` | Composed tab focus, move, open, and activation fallbacks as browser-service Effects. |
| 55 | `b444c60e` | Moved close, dedupe, suspend, reload, duplicate, mute, and history mutation actions into complete Effects. |
| 56 | `a935b97a` | Added an interruption-aware bridge from Effect transactions to browser Web Locks. |
| 57 | `5b561add` | Composed open-tab, group-color, and suspend-target snapshot reads without Promise re-entry. |
| 58 | `68413ae6` | Ran history-range read and locked write workflows in the page runtime. |
| 59 | `b6111ce6` | Ran startup-cache transactions through a shared Effect serializer in both extension contexts. |
| 60 | `b517a431` | Kept native-placement bridge message validation and handling inside the worker Effect graph. |
| 61 | `624ebd3b` | Exposed closed tabs, local state, Saved Pages, and service-state reads as composable Effects. |
| 62 | `d68b5b53` | Built page and worker startup snapshots as named concurrent Effect workflows. |
| 63 | `9dbdf4d3` | Collected complete Dashboard refresh and source-switch state inside Dashboard Intake Effects. |
| 64 | `f045d491` | Composed Saved Pages mutations, action recovery, and metadata transactions without nested runs. |
| 65 | `c33c7341` | Ran latest-wins refresh flights inside the page runtime while preserving the shared Promise adapter. |
| 66 | `82925d4a` | Kept Tab History browser and persistence sub-workflows inside its worker service. |
| 67 | `ee0c5a47` | Composed worker listener tasks, captured event state, and response settlement as named Effects. |
| 68 | `457c5b27` | Replaced startup debounce, retry, settle, and restore watchdog timers with scoped Effect fibers. |
| 69 | `9f59e911` | Composed filter and new-tab browser fallback commands directly in the worker runtime. |
| 70 | `5681b822` | Replaced page-side closed-restore watchdog timers with a scoped keyed-fiber service. |
| 71 | `df45f1eb` | Enforced that production code creates only the page and worker `ManagedRuntime`s and never uses a global Effect runner. |

After slice 70, the generated app entry is 904,252 raw bytes and the worker
entry is 359,878 raw bytes. The build reports 288.51 kB and 119.58 kB gzip
respectively. Slice 71 is test-only. These figures are observations, not caps;
the retained build assertion protects the established eight-JavaScript-asset
startup graph rather than imposing a byte threshold.

A trial conversion of the lazy Bookmarks and History source adapters was
reverted. Although each adapter could return an Effect, doing so created three
additional eager shared chunks and failed the eight-asset startup-graph check.
The conversion did not acquire concurrency, interruption, cleanup, or recovery
ownership, so weakening the graph check would have paid a startup cost for an
isolated wrapper. The Promise leaves and the graph assertion were both kept.

Beta upgrades are deliberate dependency changes requiring focused review,
full verification, and fresh bundle measurements. Reaching Effect 4 stable is
an upgrade checkpoint, not automatic authority to expand Effect into other
modules. The background worker first justified its separate Effect runtime
through Tab History serialization; that runtime now hosts every retained
worker service rather than a collection of isolated Effect islands.

## Audited Adoption Boundary

A second repository-wide audit covered Promise construction, async entry
points, shared in-flight state, queues, semaphores, timers, subscriptions,
Web Locks, MV3 listeners, persisted values, runtime and native-host messages,
JSON and subprocess protocols, and every production use of an Effect runner.
The retained architecture is now saturated under the ownership rule in this
ADR:

- The dashboard page has one lazily constructed `ManagedRuntime`. It owns the
  live Browser Tabs service and page-scoped restore watchdogs and is disposed
  on a non-BFCache `pagehide`.
- The MV3 service worker has one eagerly constructed `ManagedRuntime`. Badge,
  Working Set, Tab History, startup snapshots, and native placement are layers
  in that graph. Chrome listeners capture event-time state immediately, then
  submit named workflows to this runtime.
- Node commands run a complete Effect once at the CLI edge. They may own
  subprocesses, signals, sockets, or filesystem subscriptions, but they do not
  manufacture nested runtimes inside their workflows.
- Promise-returning exports remain compatibility adapters for React handlers,
  Chrome callbacks, tests, and lazy browser-source modules. They enter the
  appropriate shared runtime only at that outer edge.
- [`tests/effect-runtime-boundary.test.ts`](../../tests/effect-runtime-boundary.test.ts)
  prevents new production global runners or additional `ManagedRuntime`
  owners.

Effect Schema validates every extension-owned persisted-data envelope: startup
snapshots, Saved Pages, closed-history dismissals, Tab History, Working Set
activity, suspend targets, Dashboard pin snapshots and mutations, and the
history-range preference. It also validates every internal cross-context
protocol: runtime requests and responses, nested Activation History and
Working Set snapshots, closed-restore messages, and native placement host
messages. Validation remains layered: schemas establish serialized shape,
while normalizers retain backward-compatible repair and product semantics.

### Intentionally native seams

The remaining asynchronous code stays browser-native or Promise-based for
specific ownership reasons:

- `chrome.*`, storage, Web Locks, native messaging, and dynamic imports are
  platform leaf adapters. Complete parent workflows consume them through
  `Effect.tryPromise`, the Browser Tabs service, or the interruption-aware Web
  Lock bridge. Rewriting a leaf's return type alone does not add ownership.
- Bookmarks and History stay Promise-based lazy sources. The attempted Effect
  conversion changed the startup chunk graph without acquiring a lifecycle;
  the measured rejection is recorded above.
- The native-tab highlight controller's shared Promise is its UI-facing
  coalescing result. The serialized reconciliation loop, browser failures, and
  mutations already live inside one named Effect, so replacing that Promise
  with another fiber handle would change cancellation semantics rather than
  complete a missing migration.
- Dashboard page refresh debounce and optimistic pin-write revisions are page
  and React state. Their lifetime already follows the realm or component, and
  their counters express visible latest-intent semantics. A timer service or
  Effect `Ref` would add indirection without stronger cleanup or interruption.
- DOM measurement, animation frames, visual-duration waits, pointer and wheel
  listeners, tooltip timers, filter URL debounce, and dynamic UI-module
  readiness belong to React or browser rendering lifecycles. Effect types stay
  outside components, hooks, reducers, view models, and layout controllers.
- Chrome alarms and persisted storage remain the durable MV3 recovery
  authorities. Effect fibers own in-worker debounce, retry, settle, reconnect,
  and watchdog lifetimes, but cannot promise work after Chrome terminates the
  worker.
- Event-time tab/window captures and browser gateway methods stay Promise
  leaves because Chrome event ordering is observable. Their parent service
  Effects own serialization, error recovery, and persistence after capture.
- The prerender generator, request-level static-file streaming, focused
  parsers, fixtures, and the Node test runner are finite tooling boundaries.
  The surrounding build/server/test commands use Effect where they own a
  process or resource; replacing these leaves or the test runner adds no such
  ownership.

The remaining manual value checks also stay outside Effect Schema:

- Domain, section, and Page Chip identifier parsing performs product-specific
  decoding, deduplication, and compatibility repair after the storage
  container has crossed a schema boundary.
- Chrome tab, window, bookmark, session, resize-observer, and DOM values arrive
  through typed browser interfaces and are checked where optional capabilities
  or overload shapes require a runtime branch.
- Source-select values, animation targets, layout hooks, and debug samples are
  local UI inputs. Schema would spread Effect into lazy or rendering chunks
  without strengthening a serialized boundary.
- The external suspender acknowledgment has one contractual failure form, an
  `Error:` string; accepting every other response preserves compatibility with
  independently versioned extensions.

Future adoption requires a new workflow with meaningful concurrency,
interruption, resource cleanup, or typed recovery, or a new persisted or
cross-context protocol. An `async` function, Promise return type, timer, unknown
error cause, or local guard is inventory evidence, not by itself a migration
reason.

## References

- [ADR 0007](0007-one-dashboard-intake-seam-for-arriving-state.md) — the
  Dashboard Intake seam retained by this adoption
- [`CONTEXT.md`](../../CONTEXT.md) — dashboard startup and source-switch
  behavior that this internal migration preserves
