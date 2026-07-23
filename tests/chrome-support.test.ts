import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import {
  CHROME_SUPPORT_CACHE_TTL_MS,
  assessChromeSupport,
  assertGeneratedManifestMatchesPolicy,
  chromeVersionHistoryUrl,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  deriveMinimumChromeMajor,
  isChromeSupportCacheFresh,
  observeChromeStable,
  parseLatestStableVersion,
  runChromeSupportCommand,
  validateChromeSupportPolicy
} from '../scripts/chrome-support.js'

const validPolicy = validateChromeSupportPolicy({
  schemaVersion: 1,
  policy: 'latest-two-stable-majors',
  platforms: ['win', 'win64', 'win_arm64', 'mac', 'mac_arm64', 'linux'],
  minimumMajor: 149,
  lastBumpedAt: '2026-07-23',
  stableVersionsAtLastBump: {
    win: '151.0.7922.47',
    win64: '151.0.7922.47',
    win_arm64: '151.0.7922.47',
    mac: '151.0.7922.47',
    mac_arm64: '151.0.7922.47',
    linux: '150.0.7871.181'
  }
})

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

test('status fails open on an unavailable observer while release checks fail closed', async () => {
  const warnings: string[] = []
  const dependencies = {
    policy: validPolicy,
    now: new Date('2026-07-23T12:00:00Z'),
    readManifest: async () => ({ minimum_chrome_version: '149' }),
    readCache: async () => null,
    writeCache: async () => undefined,
    fetchVersionHistory: async () => { throw new Error('offline') },
    writePolicy: async () => undefined,
    log: () => undefined,
    warn: (message: string) => { warnings.push(message) },
    error: () => undefined
  }

  assert.equal(await runChromeSupportCommand('status', dependencies), 0)
  assert.equal(await runChromeSupportCommand('release-check', dependencies), 1)
  assert.ok(warnings.some((message) => message.includes('freshness is unknown')))
})

test('bump retags its fresh cache for the newly approved floor', async () => {
  const cacheWrites: Array<{ minimumMajor: number }> = []
  const policyWrites: Array<{ minimumMajor: number }> = []
  const nextStableVersions = {
    win: '151.0.7922.47',
    win64: '151.0.7922.47',
    win_arm64: '151.0.7922.47',
    mac: '151.0.7922.47',
    mac_arm64: '151.0.7922.47',
    linux: '151.0.7922.47'
  }

  const exitCode = await runChromeSupportCommand('bump', {
    policy: validPolicy,
    now: new Date('2026-07-24T12:00:00Z'),
    readManifest: async () => ({ minimum_chrome_version: '149' }),
    readCache: async () => null,
    writeCache: async (cache) => { cacheWrites.push(cache) },
    fetchVersionHistory: async (platform) => ({
      versions: [{ version: nextStableVersions[platform] }]
    }),
    writePolicy: async (policy) => { policyWrites.push(policy) },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })

  assert.equal(exitCode, 0)
  assert.equal(policyWrites.at(-1)?.minimumMajor, 150)
  assert.equal(cacheWrites.at(-1)?.minimumMajor, 150)
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

test('reuses a fresh observation cache without contacting VersionHistory', async () => {
  const cache = {
    schemaVersion: 1 as const,
    checkedAt: '2026-07-23T08:00:00.000Z',
    platforms: ['win', 'win64', 'win_arm64', 'mac', 'mac_arm64', 'linux'] as const,
    minimumMajor: 149,
    stableVersions: validPolicy.stableVersionsAtLastBump
  }
  let fetchCount = 0
  let writeCount = 0

  const observation = await observeChromeStable({
    policy: validPolicy,
    now: new Date('2026-07-23T12:00:00Z'),
    forceFresh: false,
    readCache: async () => cache,
    writeCache: async () => { writeCount += 1 },
    fetchVersionHistory: async () => {
      fetchCount += 1
      throw new Error('network should not be used')
    }
  })

  assert.equal(observation.source, 'cache')
  assert.deepEqual(observation.stableVersions, cache.stableVersions)
  assert.equal(fetchCount, 0)
  assert.equal(writeCount, 0)
})

test('a complete fresh observation survives an optional cache write failure', async () => {
  const observation = await observeChromeStable({
    policy: validPolicy,
    now: new Date('2026-07-23T12:00:00Z'),
    forceFresh: true,
    readCache: async () => null,
    writeCache: async () => { throw new Error('read-only cache') },
    fetchVersionHistory: async (platform) => ({
      versions: [{ version: validPolicy.stableVersionsAtLastBump[platform] }]
    })
  })

  assert.equal(observation.source, 'network')
  assert.match(observation.cacheWriteError ?? '', /read-only cache/)
})

test('creates an auditable bump only when the common floor advances', () => {
  const stableVersions = {
    win: '151.0.7922.47',
    win64: '151.0.7922.47',
    win_arm64: '151.0.7922.47',
    mac: '151.0.7922.47',
    mac_arm64: '151.0.7922.47',
    linux: '151.0.7922.47'
  }
  assert.deepEqual(
    createBumpedChromeSupportPolicy(validPolicy, stableVersions, new Date('2026-07-24T15:30:00Z')),
    {
      ...validPolicy,
      minimumMajor: 150,
      lastBumpedAt: '2026-07-24',
      stableVersionsAtLastBump: stableVersions
    }
  )
  assert.equal(
    createBumpedChromeSupportPolicy(
      validPolicy,
      validPolicy.stableVersionsAtLastBump,
      new Date('2026-07-24T15:30:00Z')
    ),
    null
  )
  assert.throws(
    () => createBumpedChromeSupportPolicy(validPolicy, {
      win: '150.0.7871.181',
      win64: '150.0.7871.181',
      win_arm64: '150.0.7871.181',
      mac: '150.0.7871.181',
      mac_arm64: '150.0.7871.181',
      linux: '149.0.7800.1'
    }, new Date('2026-07-24T15:30:00Z')),
    /refusing to lower/
  )
})

test('distinguishes a current, stale, and unsupported committed floor', () => {
  assert.deepEqual(
    assessChromeSupport(validPolicy, validPolicy.stableVersionsAtLastBump),
    { status: 'current', committedMinimumMajor: 149, desiredMinimumMajor: 149 }
  )
  assert.deepEqual(
    assessChromeSupport(validPolicy, {
      win: '152.0.8000.1',
      win64: '152.0.8000.1',
      win_arm64: '152.0.8000.1',
      mac: '152.0.8000.1',
      mac_arm64: '152.0.8000.1',
      linux: '152.0.8000.1'
    }),
    { status: 'behind', committedMinimumMajor: 149, desiredMinimumMajor: 151 }
  )
  assert.deepEqual(
    assessChromeSupport(validPolicy, {
      win: '150.0.7871.181',
      win64: '150.0.7871.181',
      win_arm64: '150.0.7871.181',
      mac: '150.0.7871.181',
      mac_arm64: '150.0.7871.181',
      linux: '149.0.7800.1'
    }),
    { status: 'unsupported', committedMinimumMajor: 149, desiredMinimumMajor: 148 }
  )
})

test('selects the newest complete Chrome version from a VersionHistory response', () => {
  assert.equal(
    parseLatestStableVersion({
      versions: [
        { version: '151.0.7922.45' },
        { version: '150.0.7871.181' },
        { version: '151.0.7922.47' }
      ]
    }, 'win'),
    '151.0.7922.47'
  )
  assert.throws(
    () => parseLatestStableVersion({ versions: [] }, 'win'),
    /no valid Stable versions for win/
  )
})

test('derives the common latest-two floor from the slowest supported platform', () => {
  assert.equal(
    deriveMinimumChromeMajor({
      win: '151.0.7922.47',
      win64: '151.0.7922.47',
      win_arm64: '151.0.7922.47',
      mac: '151.0.7922.47',
      mac_arm64: '151.0.7922.47',
      linux: '150.0.7871.181'
    }),
    149
  )
})

test('uses checkedAt for a seven-day cache and invalidates the exact boundary', () => {
  const now = new Date('2026-07-23T12:00:00Z')
  const cache = {
    schemaVersion: 1,
    checkedAt: new Date(now.getTime() - CHROME_SUPPORT_CACHE_TTL_MS + 1).toISOString(),
    platforms: ['win', 'win64', 'win_arm64', 'mac', 'mac_arm64', 'linux'],
    minimumMajor: 149,
    stableVersions: validPolicy.stableVersionsAtLastBump
  }

  assert.equal(isChromeSupportCacheFresh(cache, validPolicy, now), true)
  assert.equal(
    isChromeSupportCacheFresh(
      { ...cache, checkedAt: new Date(now.getTime() - CHROME_SUPPORT_CACHE_TTL_MS).toISOString() },
      validPolicy,
      now
    ),
    false
  )
  assert.equal(
    isChromeSupportCacheFresh(
      { ...cache, checkedAt: new Date(now.getTime() + 1).toISOString() },
      validPolicy,
      now
    ),
    false
  )
  assert.equal(
    isChromeSupportCacheFresh({ ...cache, minimumMajor: 148 }, validPolicy, now),
    false
  )
})

test('rejects a tracked floor that its last-bump snapshot does not justify', () => {
  assert.throws(
    () => validateChromeSupportPolicy({
      schemaVersion: 1,
      policy: 'latest-two-stable-majors',
      platforms: ['win', 'win64', 'win_arm64', 'mac', 'mac_arm64', 'linux'],
      minimumMajor: 150,
      lastBumpedAt: '2026-07-23',
      stableVersionsAtLastBump: {
        win: '151.0.7922.47',
        win64: '151.0.7922.47',
        win_arm64: '151.0.7922.47',
        mac: '151.0.7922.47',
        mac_arm64: '151.0.7922.47',
        linux: '150.0.7871.181'
      }
    }),
    /minimumMajor must be 149/
  )
})

test('rejects an impossible last-bump calendar date', () => {
  assert.throws(
    () => validateChromeSupportPolicy({
      ...validPolicy,
      lastBumpedAt: '2026-02-31'
    }),
    /lastBumpedAt must be an ISO date/
  )
})
