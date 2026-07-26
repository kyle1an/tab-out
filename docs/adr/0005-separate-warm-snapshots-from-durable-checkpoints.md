# ADR 0005: Separate Warm Snapshots From Durable Checkpoints

- Status: Accepted
- Date: 2026-07-26

## Context

The Dashboard needs a render-ready startup projection for fast repeated opens,
but rebuilding and durably rewriting the same large projection after every
material browser event amplifies CPU, serialization, and storage work. Treating
the in-session and restart-surviving copies as identical mirrors also couples
same-session paint speed to a durability policy that does not require every
intermediate generation.

A representative synthetic 564-tab snapshot measured about 1.64 MiB with its
derived startup view model and 0.51 MiB without it, a roughly 69% reduction in
the durable payload. The source snapshot still contains the Dashboard and
ordering state needed to derive that view model after a browser restart.

After the implementation, a deterministic generic-data benchmark on the
development machine used Node 26.5.0, 20 alternating warm-up rounds, and 80
alternating measured samples per case. A complete source build plus render
projection measured 1.77 ms p95 for 100 tabs and 7.81 ms p95 for 500 tabs. The
source-only payload was 65.9% and 63.5% smaller, respectively. These local
numbers are directional evidence rather than a real-Chrome CPU trace: they
support removing write amplification now, but do not by themselves justify the
complexity of incremental recomputation.

## Decision

- A **Warm Snapshot** is the render-ready current-session projection. Bounded,
  event-driven background refreshes advance it only when semantic content
  changes.
- A **Durable Checkpoint** is the restart-surviving source snapshot. It omits
  the derived startup view model and intentionally trails the Warm Snapshot.
- The first uncheckpointed material change schedules one coalesced durable
  promotion for the later of now or five minutes after the previous durable
  save. Later changes update the Warm Snapshot that will be promoted but never
  postpone the pending promotion. When Chrome delivers that work, the latest
  source is promoted without another Dashboard rebuild. The alarm does not wake
  a sleeping device, may be delivered late, and never repeats while no
  checkpoint is pending.
- A failed durable write gets at most one immediate storage retry. Persistent
  failure retains the preceding valid checkpoint and does not schedule another
  alarm by itself; a later material browser event creates the next promotion
  opportunity.
- After a restart, the page derives the render projection once from the newest
  valid Durable Checkpoint before live data arrives. Exiting the browser before
  a pending promotion may make that first paint use the preceding checkpoint.
- Cache selection compares source generations before representation richness.
  If the newest valid generation lacks its derived projection, the page derives
  it rather than selecting an older render-ready generation. An in-session
  compact fallback remains degraded and retries its render-ready write even
  when its semantic fingerprint has not changed.
- Incremental Dashboard recomputation is not part of this repair. It remains a
  measured second phase, to be considered only if profiling shows that bounded
  full rebuilds remain a material CPU cost after write amplification is
  removed.
- That measurement does not add persistent telemetry to normal extension use.
  It uses deterministic 100-tab and 500-tab benchmarks with build/write counts,
  plus an explicitly opt-in real-Chrome trace and storage-log comparison.
  Incremental recomputation proceeds only if those results show full rebuilds
  remain a dominant CPU cost after the checkpoint repair.

## Consequences

Same-session opens retain the fastest render-ready path, while durable writes
are smaller and no longer occur for every material refresh. A post-restart open
pays one view-model derivation and can briefly show older checkpointed state
before live hydration. Device sleep and platform scheduling can extend the
checkpoint lag beyond five minutes. The one-shot promotion requires an
extension alarm, but does not justify a repeating alarm or a persistent service
worker. A transient promotion failure followed by browser exit can leave the
preceding checkpoint for the next restart.

The two representations must be validated independently: a compact Durable
Checkpoint is healthy by design, while a compact Warm Snapshot is a degraded
fallback that must heal. This may add one derivation to a page open after a
write failure, but it prevents an older render-ready generation from masking
newer source state indefinitely.

## References

- [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- Startup contract: [`CONTEXT.md`](../../CONTEXT.md)
