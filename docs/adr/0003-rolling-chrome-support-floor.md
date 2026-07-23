# ADR 0003: Rolling Chrome Support Floor

- Status: Accepted
- Date: 2026-07-23

## Context

Tab Out targets Chrome Manifest V3 and does not need a cross-browser compatibility contract. Chrome Stable promotion can be staggered across desktop platforms, and Chrome's release cadence is moving from four weeks to two weeks. A hard-coded target in each build consumer or a `last 2 Chrome versions` query would either drift or depend on separately updated compatibility data.

Raising `minimum_chrome_version` is also a distribution decision: older Chrome versions cannot install the extension and existing installations below the new floor stop receiving updates. The change therefore needs to be explicit and reviewable.

## Decision

- Support the latest two Chrome Stable majors that are available on every supported Windows, macOS, and Linux architecture feed (`win`, `win64`, `win_arm64`, `mac`, `mac_arm64`, and `linux`).
- Compute the safe common floor as `min(platform Stable majors) - 1` using Chrome's official per-platform VersionHistory API.
- Keep `chrome-support.json` as the one tracked policy. Its `lastBumpedAt` and complete per-platform snapshot explain the last policy change; they do not determine when the network should be checked.
- Derive Vite's `build.target` and the manifest's `minimum_chrome_version` from the policy. Do not add Browserslist until a compatibility linter or another concrete consumer needs it.
- Keep commit-time verification offline. Cache optional developer observations outside the worktree by `checkedAt` for seven days.
- Run a fresh, fail-closed, read-only observer weekly. While the extension is unreleased, a stale result fails the workflow and directs a developer to run the reviewed bump command; it does not create commits or pull requests automatically.
- Require the bump command to observe every platform successfully, refuse automatic downgrades, update only a changed floor, rebuild generated output, and leave staging and publishing to the developer.

## Consequences

The declared install boundary and generated syntax/CSS target stay aligned, while ordinary commits remain independent of Chrome's network services. A platform-staggered rollout cannot prematurely raise the floor. Support updates appear as normal reviewable diffs with an audit date and source snapshot.

The weekly workflow can report a stale floor for up to seven days. If release readiness later needs a shorter window, increase the observer cadence and add exact Chrome for Testing lanes for the minimum supported milestone, current Stable milestones, and Beta; keep the fresh release check as the final authority.
