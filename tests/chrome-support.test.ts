import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  assertGeneratedManifestMatchesPolicy,
  chromeVersionHistoryUrl
} from '../scripts/chrome-support.js'
import {
  assessChromeSupport,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  deriveMinimumChromeMajor,
  parseLatestStableVersion,
  type ChromeStableVersions,
  type ChromeSupportPolicy
} from '../src/extension/chrome-support.js'

const validPolicy: ChromeSupportPolicy = {
  minimumMajor: 149,
  lastBumpedAt: '2026-07-23'
}

const stableVersions: ChromeStableVersions = {
  win: '151.0.7922.47',
  win64: '151.0.7922.47',
  win_arm64: '151.0.7922.47',
  mac: '151.0.7922.47',
  mac_arm64: '151.0.7922.47',
  linux: '150.0.7871.181'
}

test('requests one explicitly newest Stable version per supported platform', () => {
  assert.equal(
    chromeVersionHistoryUrl('linux'),
    'https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?page_size=1&order_by=version%20desc'
  )
})

test('check CLI runs the deterministic offline consistency check', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/chrome-support.ts', 'check'],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    new RegExp(`internally consistent at Chrome ${chromeSupportPolicy.minimumMajor}`)
  )
})

test('offline verification rejects generated manifest drift', () => {
  assert.doesNotThrow(() => assertGeneratedManifestMatchesPolicy(
    { minimum_chrome_version: '149' },
    validPolicy
  ))
  assert.throws(
    () => assertGeneratedManifestMatchesPolicy(
      { minimum_chrome_version: '148' },
      validPolicy
    ),
    /pnpm build/
  )
})

test('creates an auditable bump only when the common floor advances', () => {
  const advancedVersions = Object.fromEntries(
    Object.keys(stableVersions).map((platform) => [platform, '151.0.7922.47'])
  ) as ChromeStableVersions
  assert.deepEqual(
    createBumpedChromeSupportPolicy(
      validPolicy,
      advancedVersions,
      new Date('2026-07-24T15:30:00Z')
    ),
    { minimumMajor: 150, lastBumpedAt: '2026-07-24' }
  )
  assert.equal(createBumpedChromeSupportPolicy(validPolicy, stableVersions, new Date()), null)
  assert.throws(
    () => createBumpedChromeSupportPolicy(
      validPolicy,
      { ...stableVersions, linux: '149.0.7800.1' },
      new Date()
    ),
    /refusing to lower/
  )
})

test('distinguishes a current, stale, and unsupported committed floor', () => {
  assert.deepEqual(
    assessChromeSupport(validPolicy, stableVersions),
    { status: 'current', committedMinimumMajor: 149, desiredMinimumMajor: 149 }
  )
  assert.deepEqual(
    assessChromeSupport(validPolicy, Object.fromEntries(
      Object.keys(stableVersions).map((platform) => [platform, '152.0.8000.1'])
    ) as ChromeStableVersions),
    { status: 'behind', committedMinimumMajor: 149, desiredMinimumMajor: 151 }
  )
  assert.deepEqual(
    assessChromeSupport(validPolicy, { ...stableVersions, linux: '149.0.7800.1' }),
    { status: 'unsupported', committedMinimumMajor: 149, desiredMinimumMajor: 148 }
  )
})

test('uses the first Stable version from the descending VersionHistory response', () => {
  assert.equal(
    parseLatestStableVersion({
      versions: [
        { version: '151.0.7922.47' },
        { version: '150.0.7871.181' }
      ]
    }, 'win'),
    '151.0.7922.47'
  )
  assert.throws(
    () => parseLatestStableVersion({ versions: [] }, 'win'),
    /no Stable version for win/
  )
})

test('derives the common latest-two floor from the slowest supported platform', () => {
  assert.equal(deriveMinimumChromeMajor(stableVersions), 149)
})
