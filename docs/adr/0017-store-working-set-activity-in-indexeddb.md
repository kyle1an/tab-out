# ADR 0017: Store Working Set Activity in IndexedDB

- Status: Accepted
- Date: 2026-08-09
- Last reviewed: 2026-08-15

## Context

Working Set Activity is bounded, device-local ranking evidence. Ranking reads
keep at most 30 days and 80 events per effective page identity, and the evidence
is rebuilt from ordinary tab use when history is lost. It is also a required semantic authority
for the truthful Startup Frame: an unavailable or unsupported store is unknown,
not an empty Working Set.

The original persistence model stored every page record in one
`workingSetActivity` value in `chrome.storage.local`. Each activation or
meaningful navigation therefore parsed, serialized, and rewrote the complete
envelope even though only one page record normally changed.

An installed Manifest V3 benchmark compared that envelope with a compact
envelope, 32 deterministic Chrome-storage shards, and one IndexedDB record per
page. The canonical run used Chrome 149, fresh persistent profiles, five warmup
pairs, 30 measured pairs, and a fixed 500-record by 20-event workload. Its
fixture SHA-256 was
`68c8790abe56110d85fc64ae3f88ee6f050ba408f6c801723bb27a3bc0237ebc`.
The raw canonical report SHA-256 was
`ffa7404ff7b35a077e3f9771f3f772750ba945a1e915f7db8c1a40298d035d33`.

IndexedDB was the only replacement candidate to pass every correctness,
payload, mutation, and cold-read gate:

| Representation | Mutation bytes p95 | Mutation completion p95 | Cold full read p95 |
| --- | ---: | ---: | ---: |
| Chrome envelope | 922,508 | 56.4 ms | 33.6 ms |
| Compact envelope | 357,965 | 32.8 ms | 53.6 ms |
| 32 Chrome shards | 24,309 | 15.6 ms | 54.5 ms |
| Per-page IndexedDB | 712 | 13.5 ms | 34.6 ms |

IndexedDB reduced the logical mutation payload by about 1,296 times and p95
mutation completion by 76 percent. Its 1.0 millisecond cold-read difference was
inside the 5 millisecond budget; the paired bootstrap 95 percent interval was
-13.8 to +2.3 milliseconds. Cold Startup Frame p95 was 185.9 milliseconds for
IndexedDB and 188.0 milliseconds for the Chrome envelope.

A separate release probe then compared the frozen Chrome-envelope baseline
with the exact production adapter after migration and marker confirmation. It
used the same Chrome 149 floor, fresh persistent profiles, five warmups, and 30
alternating measured pairs. Production p95 for the full cold
`dashboard-service-state` request was 92.9 milliseconds versus 95.9
milliseconds for the baseline. The point difference was -3.0 milliseconds,
and the paired bootstrap 95 percent interval was -7.2 to +3.4 milliseconds,
inside the 9.59 millisecond regression budget. All 60 measured responses had
exactly 500 records and 10,000 events; migration markers, generation manifests,
semantic digests, failures, and cleanup errors had zero mismatches. The raw
production-probe report SHA-256 was
`c1f8ba7648e9693dd354a244d25f24252ed00fd95211f6cc5ee2ccacd4029d17`.

The continuing release probe was rerun on 2026-08-15 after the declared
minimum advanced to Chrome 151 and the production adapter adopted APIs at that
floor. It exercised the exact production bundle with the same 500-record by
20-event workload, five warmup pairs, and 30 alternating measured pairs.
Production p95 was 76.4 milliseconds versus 79.6 milliseconds for the frozen
Chrome envelope, a -3.2 millisecond point difference against a 7.96 millisecond
regression budget. The paired bootstrap 95 percent interval was -6.3 to -2.0
milliseconds. All 60 measured responses contained exactly 500 records and
10,000 events with matching semantic hashes and one direct service-state
invocation; failures and cleanup errors remained empty. This was continuing
verification rather than a new backend-selection run. The raw report SHA-256
was `808b5f01735b59288fb78e98f3c91b6ca3bb84936ae9904f69b44116a1329b1a`.

## Decision

Store only Working Set Activity as one IndexedDB row per effective page
identity. Keep Startup Frame seeds, pins, preferences, Activation History,
Saved Pages, Retained Pages, and other local authorities in their existing
stores.

- Use the pinned `idb` 8.0.3 wrapper for typed databases, upgrades, indexes,
  transactions, and explicit `transaction.done` completion. Do not use
  `idb-keyval`: the selected representation needs a named store, an expiry
  index, version ownership, and multi-request transactions.
- Keep `WorkingSetActivityStorage` as the repo-owned Effect service. IndexedDB,
  generation, and wrapper types stay behind its existing Layer so Working Set,
  Tab History, Startup Frame messages, and domain models do not depend on
  `idb`.
- Keep Layer construction synchronous. Open IndexedDB lazily inside storage
  operations, cache a connection only for the current MV3 worker lifetime, and
  reopen after termination. Close a connection when it blocks a newer version;
  reject a blocked or unsupported open instead of hanging or recreating a false
  empty authority.
- Store compact rows containing only title, optional dismissal timestamps,
  ordered activation/navigation timestamp tuples, and the validated
  `lastEventAt` expiry projection. Derive URL, domain, last-seen, and per-kind
  last-event projections after Schema validation.
- Give each staged authority a deterministic database generation derived from
  the physical schema version and canonical source digest. Each generation
  database contains a `page-activity` store, a `last-event-at` index, and a
  committed generation manifest. This keeps ordinary row keys and index access
  identical to the measured candidate while making the target generation
  explicit.
- Accept an authority marker only when its schema and exact own-key set match.
  During marker-absent bootstrap, stage a verified known-empty generation and
  remove stale databases owned by this same v1 generation format before writing
  the target; leave differently named and future-version databases untouched.
- Use `durability: 'relaxed'` for ordinary rebuildable row mutations, but await
  every request and `transaction.done` before updating Working Set's in-memory
  cache. Use `durability: 'strict'` for generation staging and full replacement.
- Treat malformed rows or events as isolated damage during ordinary reads so
  valid siblings survive. Treat a missing marked database, store, index, or
  manifest; an unsupported version; or a backend open/read failure as unknown
  and fail the Startup Frame. Best-effort expiry deletion may fail only after a
  complete semantic read remains known.

### Authority bootstrap and completed rollout

When the authority marker is absent, the current adapter initializes a
known-empty generation under the storage backend's serializer:

1. Capture one initialization time, construct the empty Working Set activity,
   and derive its canonical SHA-256 digest and zero counts.
2. Strictly stage the empty target and generation manifest in one IndexedDB
   transaction, then await `transaction.done`.
3. Reopen the exact generation without permitting database creation, read it
   through a fresh transaction, Schema-decode it strictly, and verify the
   digest, counts, projections, and retention bounds.
4. Write the versioned authority marker to `chrome.storage.local`, read it back,
   and require exact equality.
5. Cache and use the IndexedDB authority only after marker confirmation.

Before the marker, a restart may safely replace an ignored orphan generation
owned by the same schema. After the marker, only its exact generation is
authoritative. A missing or invalid marked target fails the truthful Startup
Frame instead of being recreated as false empty truth. The marker field name
`cutoverAt` remains part of schema 1 for compatibility and records the bootstrap
or historical rollout time.

Historically, the first IndexedDB release used the same staged verification to
migrate the bounded `workingSetActivity` Chrome value, retained the verified
source for one release, and stopped shadow-writing it. A follow-up update
validated the marked generation and retired that stale value. After every
tracked profile confirmed the marker, database, and key deletion independently,
the update-only retirement and marker-absent legacy migration paths were
removed. The current adapter never reads, writes, or deletes that Chrome key;
markerless profiles start from a verified empty IndexedDB generation.

A deliberate rollback remains unimplemented. An older-build downgrade may
therefore lose post-cutover ranking evidence and rebuild it naturally. Any
future rollback must construct and verify a fresh legacy projection from the
current marked authority before switching backends.

## Consequences

Ordinary activity changes serialize and write one compact row instead of the
whole retained history. Corruption is contained per page, and expiry can use an
index. The production adapter adds database-version, connection, manifest,
transaction, and authority-bootstrap code compared with one Chrome key. That
mechanism is kept in a deep storage module rather than distributed through
domain services.

The logical mutation-byte result is not a disk-footprint claim. Chrome's
IndexedDB origin allocation and Chrome-owned storage-key bytes are not directly
comparable. The memory experiments measured only worker and Dashboard V8 heaps:
they do not establish lower aggregate Chrome RSS or renderer memory.

Semantic reads discard events older than 30 days. A still-live physical row can
temporarily retain older compact event tuples until that row is rewritten or
its `lastEventAt` itself expires and the whole row is swept. That is the same
semantic retention boundary as the previous envelope, not proof of immediate
physical erasure. Tightening physical event compaction would change cold-read
and write behavior and therefore requires its own privacy decision and benchmark.

The benchmark's fused synchronous row decoder is retained. Cursor streaming and
overlapped expiry deletion are rejected: they missed their declared benefit or
latency gates and added lifecycle complexity. Dexie is unnecessary for one
worker-owned store, localForage adds irrelevant fallback drivers, raw IndexedDB
duplicates the transaction/open wrapper, and the current Effect IndexedDB
implementation does not yet satisfy the worker-layer and commit-completion
contract.

A future Effect-native adapter may replace only the Layer without copying data
if it opens this same native database generation, stores, indexes, manifest, and
structured-clone row format. A stable version label alone is insufficient; it
must also pass MV3 cold-open, transaction completion, abort, blocking,
termination, upgrade, schema, bundle, and latency tests.

## Evidence expiration

Re-run the installed-extension correctness and 30-pair performance gate before
changing the physical row encoding, database/index layout, wrapper major,
retention or event caps, minimum Chrome behavior relevant to IndexedDB, or the
Startup Frame's full Working Set read contract. Re-run it as well if production
telemetry or real-Chrome QA shows blocked upgrades, expiry tails, or cold reads
outside the accepted budget. The canonical four-candidate benchmark and its
diagnostics remain test code and never become a runtime backend selector. The
non-selection heap-lifetime and real-tab-scaling explorations were decision-time
evidence and were retired after the production adapter and release probe fixed
the continuing verification authority.
