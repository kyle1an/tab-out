# ADR 0003: Rolling Chrome Support Floor

- Status: Accepted
- Date: 2026-07-23
- Updated: 2026-08-12

## Context

Tab Out targets Chrome Manifest V3 on Apple silicon Macs and does not need a cross-browser, cross-operating-system, or Intel Mac compatibility contract. Chrome's release cadence is moving from four weeks to two weeks. A hard-coded target in each build consumer or a `last 2 Chrome versions` query would either drift or depend on separately updated compatibility data.

Raising `minimum_chrome_version` is also a distribution decision: older Chrome versions cannot install the extension and existing installations below the new floor stop receiving updates. The change therefore needs to be explicit and reviewable.

On 2026-08-12, the approved policy narrowed from the latest two common desktop Stable majors to the latest Apple silicon Chrome Stable major. This reflects Tab Out's intended deployment and lets the install boundary follow the supported architecture's release cadence instead of waiting for unrelated platform feeds or retaining the preceding major.

## Decision

- Support the latest Chrome Stable major from the Apple silicon feed (`mac_arm64`). Intel Mac, Windows, and Linux feeds are outside the support policy.
- Compute the floor from Chrome's official `mac_arm64` VersionHistory API response.
- Keep `chrome-support.json` as the tracked numeric floor and audit date, and keep `CHROME_PLATFORMS` as the VersionHistory feed-scope authority. `lastBumpedAt` records the last policy change; it does not determine when the network should be checked.
- Derive Vite's `build.target` and the manifest's `minimum_chrome_version` from the policy. Run the Playwright harness with its bundled Chromium and require that browser's major to equal the policy floor, so browser tests exercise the oldest supported version rather than whichever Chrome is installed locally. Do not add Browserslist until a compatibility linter or another concrete consumer needs it.
- Keep commit-time verification offline.
- Run a fresh, fail-closed, read-only observation manually before a release or when reviewing the support floor. A stale result directs the developer to run the reviewed bump command; it does not change files automatically.
- Require the bump command to observe the Apple silicon Stable feed successfully, refuse automatic downgrades, update only a changed floor, rebuild generated output, and leave staging and publishing to the developer. Git history records the observation that caused each reviewed bump.
- Treat Apple silicon as a support and verification boundary, not a runtime architecture gate. Do not add CPU detection, reject otherwise working installations, or make the optional native integration fail solely because the host is an Intel Mac.

## Consequences

The declared install boundary and generated syntax/CSS target stay aligned, while ordinary commits remain independent of Chrome's network services. Intel promotion timing no longer delays Apple silicon floor updates. Support updates appear as normal reviewable diffs with an audit date; Git history preserves the reviewed change. The architecture-neutral extension may continue to run elsewhere, but no compatibility claim is made for Intel Mac, Windows, or Linux Chrome.

A floor bump may also require updating `@playwright/test` to a release that bundles the new minimum Chromium major before the offline consistency check passes. When Playwright's stable releases skip that Chromium major, pin the newest matching prerelease exactly and prove it through the full browser and extension suites. Real-Chrome inspection remains necessary for extension APIs and service-worker behavior; the bundled-browser lane is the deterministic floor check for the localhost harness.

Without a scheduled observer, a stale floor is surfaced only when a developer runs `pnpm chrome-support:release-check` or `pnpm chrome-support:bump`. This is intentional for the current single-owner, unreleased workflow; reconsider server-side automation if the release cadence or contributor model changes.

## References

- [Chrome VersionHistory API](https://developer.chrome.com/docs/web-platform/versionhistory/reference)
- [Extension `minimum_chrome_version`](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)
