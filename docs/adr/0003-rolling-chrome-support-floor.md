# ADR 0003: Rolling Chrome Support Floor

- Status: Accepted
- Date: 2026-07-23
- Updated: 2026-07-26

## Context

Tab Out targets Chrome Manifest V3 and does not need a cross-browser compatibility contract. Chrome Stable promotion can be staggered across desktop platforms, and Chrome's release cadence is moving from four weeks to two weeks. A hard-coded target in each build consumer or a `last 2 Chrome versions` query would either drift or depend on separately updated compatibility data.

Raising `minimum_chrome_version` is also a distribution decision: older Chrome versions cannot install the extension and existing installations below the new floor stop receiving updates. The change therefore needs to be explicit and reviewable.

## Decision

- Support the latest two Chrome Stable majors that are available on every supported Windows, macOS, and Linux architecture feed (`win`, `win64`, `win_arm64`, `mac`, `mac_arm64`, and `linux`).
- Compute the safe common floor as `min(platform Stable majors) - 1` using Chrome's official per-platform VersionHistory API.
- Keep `chrome-support.json` as the one tracked policy. Its `lastBumpedAt` records the last policy change; it does not determine when the network should be checked.
- Derive Vite's `build.target` and the manifest's `minimum_chrome_version` from the policy. Run the Playwright harness with its bundled Chromium and require that browser's major to equal the policy floor, so browser tests exercise the oldest supported version rather than whichever Chrome is installed locally. Do not add Browserslist until a compatibility linter or another concrete consumer needs it.
- Keep commit-time verification offline.
- Run a fresh, fail-closed, read-only observation manually before a release or when reviewing the support floor. A stale result directs the developer to run the reviewed bump command; it does not change files automatically.
- Require the bump command to observe every platform successfully, refuse automatic downgrades, update only a changed floor, rebuild generated output, and leave staging and publishing to the developer. Git history records the observation that caused each reviewed bump.

## Consequences

The declared install boundary and generated syntax/CSS target stay aligned, while ordinary commits remain independent of Chrome's network services. A platform-staggered rollout cannot prematurely raise the floor. Support updates appear as normal reviewable diffs with an audit date; Git history preserves the reviewed change.

A floor bump may also require updating `@playwright/test` to a release that bundles the new minimum Chromium major before the offline consistency check passes. When Playwright's stable releases skip that Chromium major, pin the newest matching prerelease exactly and prove it through the full browser and extension suites. Real-Chrome inspection remains necessary for extension APIs and service-worker behavior; the bundled-browser lane is the deterministic floor check for the localhost harness.

Without a scheduled observer, a stale floor is surfaced only when a developer runs `pnpm chrome-support:release-check` or `pnpm chrome-support:bump`. This is intentional for the current single-owner, unreleased workflow; reconsider server-side automation if the release cadence or contributor model changes.

## References

- [Chrome VersionHistory API](https://developer.chrome.com/docs/web-platform/versionhistory/reference)
- [Extension `minimum_chrome_version`](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)
