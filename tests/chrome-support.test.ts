import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  assertBrowserTestFloorMatchesPolicy,
  assertGeneratedManifestMatchesPolicy,
  chromeVersionHistoryUrl,
  parsePlaywrightChromiumVersion,
} from '../scripts/chrome-support.js'
import {
  assessChromeSupport,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  deriveMinimumChromeMajor,
  isChromeStableVersions,
  parseLatestStableVersion,
  type ChromeStableVersions,
  type ChromeSupportPolicy,
} from '../src/extension/chrome-support.js'
import playwrightConfig from './playwright.config.js'

const validPolicy: ChromeSupportPolicy = {
  minimumMajor: 149,
  lastBumpedAt: '2026-07-23',
}

const stableVersions: ChromeStableVersions = {
  mac_arm64: '150.0.7871.181',
}

test('requests the newest Apple silicon Stable release that reached 100% rollout', () => {
  assert.equal(
    chromeVersionHistoryUrl('mac_arm64'),
    'https://versionhistory.googleapis.com/v1/chrome/platforms/mac_arm64/channels/stable/versions/all/releases?filter=fraction=1&page_size=1&order_by=version%20desc',
  )
})

test('check CLI runs the deterministic offline consistency check', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/chrome-support.ts', 'check'],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    new RegExp(`internally consistent at Chrome ${chromeSupportPolicy.minimumMajor}`),
  )
})

test('CLI rejects an unknown command with the usage exit code', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/chrome-support.ts', 'unknown'],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: chrome-support\.ts <check\|bump\|release-check>/)
})

test('offline verification rejects generated manifest drift', () => {
  assert.doesNotThrow(() => assertGeneratedManifestMatchesPolicy(
    { minimum_chrome_version: '149' },
    validPolicy,
  ))
  assert.throws(
    () => assertGeneratedManifestMatchesPolicy(
      { minimum_chrome_version: '148' },
      validPolicy,
    ),
    /pnpm build/,
  )
})

test('offline verification pins browser tests to the minimum supported Chrome major', () => {
  assert.doesNotThrow(() => assertBrowserTestFloorMatchesPolicy('149.0.7827.55', validPolicy))
  assert.throws(
    () => assertBrowserTestFloorMatchesPolicy('150.0.7871.0', validPolicy),
    /bundle Chromium 149\.x/,
  )
  assert.throws(
    () => assertBrowserTestFloorMatchesPolicy(null, validPolicy),
    /Update @playwright\/test/,
  )
})

test('Playwright metadata selects only the default bundled Chromium', () => {
  assert.equal(parsePlaywrightChromiumVersion({
    browsers: [
      { name: 'chromium', installByDefault: false, browserVersion: '148.0.0.0' },
      { name: 'chromium', installByDefault: true, browserVersion: '149.0.7827.55' },
    ],
  }), '149.0.7827.55')
  assert.equal(parsePlaywrightChromiumVersion({ browsers: 'malformed' }), null)
})

test('browser harness owns its server and uses the bundled full Chromium', () => {
  assert.equal(playwrightConfig.use?.browserName, 'chromium')
  assert.equal(playwrightConfig.use?.channel, 'chromium')
  const webServer = playwrightConfig.webServer
  assert.ok(webServer && !Array.isArray(webServer))
  assert.equal(webServer.reuseExistingServer, false)
  assert.equal(webServer.url, `${String(playwrightConfig.use?.baseURL)}/tests/fixtures/dashboard-resize.html`)
  assert.equal(webServer.env?.PORT, new URL(String(playwrightConfig.use?.baseURL)).port)
})

test('creates an auditable bump only when the Apple silicon floor advances', () => {
  const advancedVersions = Object.fromEntries(
    Object.keys(stableVersions).map((platform) => [platform, '151.0.7922.47']),
  ) as ChromeStableVersions
  assert.deepEqual(
    createBumpedChromeSupportPolicy(
      validPolicy,
      advancedVersions,
      new Date('2026-07-24T15:30:00Z'),
    ),
    { minimumMajor: 151, lastBumpedAt: '2026-07-24' },
  )
  assert.deepEqual(
    createBumpedChromeSupportPolicy(
      validPolicy,
      stableVersions,
      new Date('2026-07-23T15:30:00Z'),
    ),
    { minimumMajor: 150, lastBumpedAt: '2026-07-23' },
  )
  assert.equal(createBumpedChromeSupportPolicy(
    { ...validPolicy, minimumMajor: 150 },
    stableVersions,
    new Date(),
  ), null)
  assert.throws(
    () => createBumpedChromeSupportPolicy(
      validPolicy,
      { ...stableVersions, mac_arm64: '148.0.7750.1' },
      new Date(),
    ),
    /refusing to lower/,
  )
})

test('distinguishes a current, stale, and unsupported committed floor', () => {
  const currentPolicy = { ...validPolicy, minimumMajor: 150 }
  assert.deepEqual(
    assessChromeSupport(currentPolicy, stableVersions),
    { status: 'current', committedMinimumMajor: 150, desiredMinimumMajor: 150 },
  )
  assert.deepEqual(
    assessChromeSupport(currentPolicy, Object.fromEntries(
      Object.keys(stableVersions).map((platform) => [platform, '152.0.8000.1']),
    ) as ChromeStableVersions),
    { status: 'behind', committedMinimumMajor: 150, desiredMinimumMajor: 152 },
  )
  assert.deepEqual(
    assessChromeSupport(currentPolicy, { ...stableVersions, mac_arm64: '149.0.7800.1' }),
    { status: 'unsupported', committedMinimumMajor: 150, desiredMinimumMajor: 149 },
  )
})

test('uses the newest Stable release that reached 100% rollout', () => {
  assert.equal(
    parseLatestStableVersion({
      releases: [
        { version: '151.0.7922.47', fraction: 1 },
        { version: '150.0.7871.181', fraction: 1 },
      ],
    }, 'mac_arm64'),
    '151.0.7922.47',
  )
  assert.throws(
    () => parseLatestStableVersion({ releases: [] }, 'mac_arm64'),
    /no Stable release at 100% rollout for mac_arm64/,
  )
})

test('rejects early rollouts and version listings without release evidence', () => {
  for (const value of [
    { releases: [{ version: '153.0.8010.12', fraction: 0.01 }] },
    { releases: [{ version: '153.0.8010.12' }] },
    { versions: [{ version: '153.0.8010.12' }] },
  ]) {
    assert.throws(
      () => parseLatestStableVersion(value, 'mac_arm64'),
      /no Stable release at 100% rollout for mac_arm64/,
    )
  }
})

test('derives the Stable floor from the Apple silicon feed', () => {
  assert.equal(isChromeStableVersions(stableVersions), true)
  assert.equal(isChromeStableVersions({ ...stableVersions, mac_arm64: undefined }), false)
  assert.equal(deriveMinimumChromeMajor(stableVersions), 150)
})
