# Maintaining a Rolling Chrome Support Floor

Research snapshot: 2026-07-23

## Current repository setup

The repository now implements the conservative pre-release variant of this guidance:

- `chrome-support.json` records the reviewed cross-platform floor, last bump date, and complete Windows, macOS, and Linux architecture snapshot.
- Vite and the generated extension manifest derive their targets from that one policy.
- `pnpm verify` begins with an offline consistency check; it never discovers browser releases.
- `pnpm chrome-support:status` uses an untracked seven-day observation cache based on `checkedAt`, not `lastBumpedAt`.
- `pnpm chrome-support:bump` forces a complete fresh observation, updates only an advancing floor, rebuilds generated output, and leaves the diff unstaged for review.
- `.github/workflows/chrome-support.yml` runs a fresh read-only check weekly and on manual dispatch. Because the extension is not being released yet, it reports drift by failing instead of granting write permissions or opening a pull request automatically.

The pull-request bot and exact historical-browser matrix described below remain the recommended release-readiness upgrade, not part of the current setup.

## Recommendation

For an extension that supports only the latest two Chrome Stable milestones, the most robust industry pattern is:

1. Keep one explicit minimum Chrome major in source control.
2. Derive the manifest, Vite target, compatibility-lint target, and minimum-version test from that value.
3. Keep commit-time checks deterministic and offline; they should verify internal consistency, not discover releases over the network.
4. Run a scheduled release observer against Chrome's official per-platform VersionHistory API. When the support floor changes, let it open a reviewed pull request instead of changing the floor silently.
5. Test the built extension on the minimum supported milestone and every distinct current Stable milestone across the supported desktop platforms. Test Beta as an advisory early-warning lane.
6. Require a fresh official-version check and the full required browser matrix only when a release is prepared.

This is preferable to using `lastBumpedAt` as a network-cache key. The bump time records a policy decision; it does not prove that no Chrome milestone was released afterward.

## Current timing constraint

Chrome promotion is platform-staggered. At this snapshot, the official VersionHistory API reports Chrome 151 Stable on all tracked Windows feeds ([win](https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions), [win64](https://versionhistory.googleapis.com/v1/chrome/platforms/win64/channels/stable/versions), and [win_arm64](https://versionhistory.googleapis.com/v1/chrome/platforms/win_arm64/channels/stable/versions)) and both tracked macOS feeds ([mac](https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions) and [mac_arm64](https://versionhistory.googleapis.com/v1/chrome/platforms/mac_arm64/channels/stable/versions)), while [Linux](https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions) remains on Chrome 150. The safe common floor therefore remains Chrome 149 until Linux reaches 151. Chrome's VersionHistory API is explicitly platform- and channel-aware ([VersionHistory API reference](https://developer.chrome.com/docs/web-platform/versionhistory/reference)).

Chrome for Testing already reports 151 as its downloadable Stable build, demonstrating why its single channel value must not be used by itself to raise a cross-platform user-support floor. Use Chrome for Testing to select reproducible test binaries, and use VersionHistory to decide what users on each supported platform can currently receive ([Chrome for Testing endpoint reference](https://github.com/GoogleChromeLabs/chrome-for-testing#json-api-endpoints)).

A fixed 28-day release assumption is already becoming obsolete. Chrome will move from four-week to two-week Beta and Stable milestones beginning with Chrome 153 on September 8, 2026 ([Chrome two-week release announcement](https://developer.chrome.com/blog/chrome-two-week-release)). A cache based on a presumed release interval can therefore become stale when Chrome changes its schedule, delays a release, or a bump happens shortly before the next Stable promotion.

## Source of truth

Use a small tool-neutral policy file rather than making Vite, Browserslist, or the generated manifest authoritative. For example:

```json
{
  "schemaVersion": 1,
  "policy": "latest-two-stable-majors",
  "platforms": ["win", "win64", "win_arm64", "mac", "mac_arm64", "linux"],
  "minimumMajor": 149,
  "lastBumpedAt": "2026-07-23",
  "stableVersionsAtLastBump": {
    "win": "151.0.7922.47",
    "win64": "151.0.7922.47",
    "win_arm64": "151.0.7922.47",
    "mac": "151.0.7922.47",
    "mac_arm64": "151.0.7922.47",
    "linux": "150.0.7871.181"
  }
}
```

`minimumMajor` is normative. `lastBumpedAt` is optional audit metadata; Git history and the bump pull request already provide an audit trail, so it should not drive correctness. Avoid committing a timestamp after every no-op network check because that creates history churn without changing browser support.

The following values should be derived from, or checked against, `minimumMajor`:

| Consumer | Derived value | Purpose |
| --- | --- | --- |
| Vite | `chrome${minimumMajor}` | JavaScript syntax and CSS build target |
| Manifest source | `String(minimumMajor)` | `minimum_chrome_version` enforcement |
| Browserslist, if introduced | `Chrome >= ${minimumMajor}` | Compatibility lint consumers only |
| Minimum-browser test | exact Chrome for Testing build from that milestone | Runtime proof at the floor |
| Current-Stable tests | exact builds for each distinct current Stable major across supported platforms | Proof across a staggered rollout |

Vite documents `build.target` as its final-bundle compatibility target and accepts an exact browser target such as `chrome58`; `build.cssTarget` defaults to the JavaScript target ([Vite build options](https://vite.dev/config/build-options.html#build-target)). Vite also states that it performs syntax transforms but does not provide general polyfills, so matching the build target does not prove that every DOM or Web API exists ([Vite browser compatibility](https://vite.dev/guide/build.html#browser-compatibility)).

The manifest is the enforcement boundary. Chrome accepts a major number for `minimum_chrome_version`; older browsers cannot install the extension, and existing installations below a raised floor silently stop receiving updates ([Chrome extension minimum-version documentation](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)). Even before public release, keeping the manifest aligned prevents development and testing from exercising an undeclared contract.

Add one fast consistency test that reads the policy and asserts:

- Vite's target equals the policy target.
- The generated manifest's minimum equals the policy minimum.
- Any Browserslist query equals the policy minimum.
- The minimum-browser test configuration resolves the same major.

That test belongs in normal verification and the pre-commit hook because it is local, deterministic, and read-only.

## Release discovery and update automation

### Preferred model: scheduled observer and reviewed pull request

Run a scheduled workflow weekly, plus allow manual dispatch. Weekly observation has at most about seven days of discovery lag even after Chrome moves to a two-week release cycle; that is adequate for an unreleased extension. If the policy must track Stable nearly immediately later, change the observer to daily rather than moving network access into every commit.

The observer should:

1. Fetch the newest Stable version for every explicitly supported platform from Chrome's VersionHistory API.
2. Parse and retain the complete per-platform version snapshot.
3. Compute the desired common minimum as `min(platform Stable majors) - 1`, then use Chrome for Testing to confirm that downloadable artifacts exist for the milestones under test.
4. Exit without writing anything when the committed floor is current.
5. Otherwise run a repository-owned bump command that updates the one policy file, regenerates derived output, and runs verification.
6. Open a pull request that reports the old floor, new floor, observed per-platform Stable versions, source URLs, and test results.
7. Require human review; do not auto-merge a support-policy change.

The VersionHistory API provides programmatic Chrome version history by platform and channel, making it the correct source for the support-policy calculation ([VersionHistory API guide](https://developer.chrome.com/docs/web-platform/versionhistory/guide)). Chrome for Testing publishes reproducible, non-auto-updating binaries plus known-good historical-version endpoints, making it the correct source for the browser-test artifacts after the floor is calculated ([Chrome for Testing endpoint reference](https://github.com/GoogleChromeLabs/chrome-for-testing#json-api-endpoints)). Both are better than scraping a release blog.

GitHub Actions scheduled workflows run from the default branch and may be delayed under load, so they are appropriate release observers but should not be treated as exact-time release infrastructure ([GitHub scheduled-workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).

### Bot choices

| Mechanism | Fit | Notes |
| --- | --- | --- |
| Small scheduled workflow plus repository script | Best default | Easy to understand, can compute the preceding milestone, regenerate artifacts, and run project checks |
| Renovate custom manager and custom datasource | Good if Renovate is already adopted | Renovate can find an arbitrary version field with a regex manager and request generic HTTP(S) version data with a custom datasource ([regex manager](https://docs.renovatebot.com/modules/manager/regex/), [custom datasource](https://docs.renovatebot.com/modules/datasource/custom/)) |
| Dependabot | Poor fit for the Chrome floor | Dependabot version updates operate on supported package ecosystems and their manifests; a project-specific Chrome support policy is not one of those ecosystems ([Dependabot supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)) |
| Browserslist database updater | Different job | It refreshes `caniuse-lite` in the lockfile for dynamic Browserslist queries; it does not update Vite's explicit target, the extension manifest, or pinned browser tests ([update-browserslist-db](https://github.com/browserslist/update-db#readme)) |

A dedicated repository script is the least surprising option here. Renovate becomes attractive if the repository later uses it broadly, but a custom data transform solely for `Stable major - 1` is more machinery than the policy requires.

## Cache and check cadence

Keep three concepts separate:

| State | Where it belongs | Meaning |
| --- | --- | --- |
| `minimumMajor` | Tracked policy file | Approved compatibility contract |
| `lastBumpedAt` | Optional tracked metadata or Git history | When that contract last changed |
| `checkedAt` and observed per-platform Stable versions | Scheduled-run output or ignored local cache | How fresh and complete the latest network observation is |

The preferred scheduled workflow needs no cross-run cache: one small official request per week is simpler and more reliable than restoring state. If a developer-facing status command is added, it may use an ignored local cache with a seven-day TTL. Its TTL must be based on `checkedAt`, never `lastBumpedAt`; network timeout should produce an “unknown/stale” warning rather than block local work.

Do not commit `checkedAt` after successful no-op checks. Do not let an ignored cache satisfy a release gate. A release check should bypass the cache and fetch official data afresh.

## Pre-commit and network boundaries

Pre-commit should remain offline. It can run the consistency assertion and existing unit/build checks, but should not contact Chrome, download a browser, update policy files, stage files, or depend on the availability of a third-party service.

This separation gives each layer one job:

- Pre-commit: prove the current checkout is internally consistent.
- Pull-request CI: prove the built code works against the committed support contract.
- Scheduled observer: discover whether Chrome has moved.
- Release gate: prove the contract is current immediately before distribution.

If an “official status on every commit” command is still desired, make it an explicitly invoked informational command or a fail-open wrapper around the offline assertion. A confirmed stale floor may fail; an unavailable network should not prevent a local commit.

## Browser test matrix

The minimum supported version is the highest-value compatibility test. Testing only the developer's auto-updated Stable browser can allow accidental use of APIs introduced after the declared floor.

| Lane | Trigger | Enforcement | Scope |
| --- | --- | --- | --- |
| Minimum supported milestone | Every pull request | Required | Full unit/integration suite plus real-extension smoke |
| Distinct current Stable milestones across supported platforms | Every pull request or main branch | Required before release | Full or representative browser suite; collapse duplicate majors |
| Chrome Beta | Weekly and before each Chrome release | Advisory until intentionally promoted | Real-extension smoke and high-risk flows |

Chrome recommends testing Beta at least once per browser release, and its current guidance treats pre-Stable channels as the early-warning path for removals and behavior changes ([Chrome testing guidance](https://developer.chrome.com/docs/web-platform/implement-testing-in-your-enterprise), [Chrome deprecation guidance](https://developer.chrome.com/docs/web-platform/chrome-deprecation)). Playwright supports branded `chrome` and `chrome-beta` channels and recommends staying current to catch failures before new browser versions reach users ([Playwright browser documentation](https://playwright.dev/docs/browsers)).

For the exact minimum milestone, install an explicit Chrome for Testing version rather than relying on an auto-updated local Chrome. The test framework is secondary to the browser contract: Chrome's extension guidance lists both Playwright and Puppeteer, and defines extension end-to-end testing as building and loading the extension package into a browser ([Chrome extension end-to-end testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)).

Keep fixture-based UI tests, but add at least a small unpacked-extension lane that proves:

- the generated manifest loads;
- the new-tab override opens;
- the MV3 service worker starts and handles a representative message;
- required `chrome.*` APIs work;
- a service-worker restart does not lose required state.

Chrome explicitly recommends testing extension service-worker termination because workers can stop without warning and in-memory state is lost ([service-worker termination testing](https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer)).

## Browserslist and compatibility linting

Browserslist is useful only after a tool consumes it. Its own documentation lists consumers such as `eslint-plugin-compat` and `stylelint-no-unsupported-browser-features`; Vite's documented build authority remains `build.target` ([Browserslist documentation](https://github.com/browserslist/browserslist#readme), [Vite build options](https://vite.dev/config/build-options.html#build-target)).

If compatibility linting is added, expose an explicit query derived from the policy:

```text
Chrome >= 149
```

Do not make `last 2 Chrome versions` the canonical policy. That query is evaluated using the installed `caniuse-lite` data, and the Browserslist updater changes that data in the lockfile ([Browserslist updater documentation](https://github.com/browserslist/update-db#why-you-need-to-call-it-regularly)). Two builds of the same source policy could therefore resolve different targets after dependency metadata changes unless the lockfile is held constant. An explicit floor also maps cleanly to `minimum_chrome_version` and exact test binaries.

Compatibility linting is defense in depth, not proof:

- Vite catches/transforms supported syntax according to its target.
- A Browserslist consumer can flag covered web APIs or CSS features.
- TypeScript libraries control which standard types are visible during compilation.
- Real Chrome tests prove runtime behavior.
- Chrome extension APIs still require their own documentation/version checks and runtime tests; general web compatibility databases do not define the extension API surface.

Tailwind v4 does not need Browserslist to establish its own baseline. Tailwind documents a built-in minimum of Chrome 111, Safari 16.4, and Firefox 128, while warning that individual bleeding-edge utilities can require newer browsers ([Tailwind compatibility](https://tailwindcss.com/docs/compatibility)). A Chrome 149 floor exceeds Tailwind's core minimum, but newly used CSS features should still be checked against the explicit project floor.

Web Platform Baseline is useful background information, but it is intentionally cross-browser and does not cover Chrome extension APIs. It should not replace a Chrome-only floor. Baseline describes interoperability across Chrome, Edge, Firefox, and Safari and explicitly says it is not a substitute for testing ([Baseline overview](https://web.dev/baseline/), [MDN Baseline definition](https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility)).

## Release gate

When public release becomes relevant, add a strict command such as `chrome-support:release-check` that:

1. Bypasses any local cache and fetches official Stable versions for every supported platform.
2. Confirms that the committed minimum represents the intended common two-Stable-milestone window during any staggered rollout.
3. Confirms Vite, manifest, lint, and browser-test targets agree.
4. Runs the built extension on the minimum plus every distinct current Stable milestone in the supported-platform snapshot.
5. Runs the Beta smoke lane or records an explicit waiver.
6. Requires the support-floor change to have been reviewed rather than auto-merged.

Make that command a required pull-request status check for release preparation; GitHub can prevent merging until required checks pass ([GitHub status-check documentation](https://docs.github.com/en/pull-requests/reference/status-checks)). Raising the manifest minimum should remain a deliberate product decision because Chrome silently withholds future extension updates from existing users below the new floor. Chrome's own extension guidance recommends treating a minimum-version raise deliberately and using a staged rollout when distributing it ([Chrome browser-namespace transition guidance](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)).

## Suggested lifecycle for this unreleased extension

- **Every commit:** offline policy-consistency assertion only.
- **Weekly:** official per-platform Stable observer; no-op when unchanged, otherwise open a bump pull request.
- **Every support-floor pull request:** update the one policy value, regenerate derived files, and test the exact minimum plus every distinct current Stable milestone across supported platforms.
- **Weekly advisory:** run the unpacked-extension smoke against Beta.
- **Before a future release:** bypass caches, confirm every supported platform's current Stable from the official API, run the required milestone matrix, and require review.

This captures the benefit of a rolling policy without making local commits depend on the network or letting browser support change implicitly when a browser database is refreshed.
