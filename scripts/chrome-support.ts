import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assessChromeSupport,
  chromeMajor,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  parseLatestStableVersion,
  type ChromePlatform,
  type ChromeSupportPolicy
} from '../src/extension/chrome-support.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const POLICY_FILE = join(REPO_ROOT, 'chrome-support.json')
const MANIFEST_FILE = join(REPO_ROOT, 'extension/manifest.json')
const VERSION_HISTORY_BASE_URL = 'https://versionhistory.googleapis.com/v1/chrome/platforms'
const VERSION_HISTORY_TIMEOUT_MS = 5_000

export {
  CHROME_BUILD_TARGET,
  CHROME_PLATFORMS,
  MINIMUM_CHROME_VERSION,
  assessChromeSupport,
  chromeMajor,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  deriveMinimumChromeMajor,
  parseLatestStableVersion,
  validateChromeSupportPolicy
} from '../src/extension/chrome-support.js'
export type {
  ChromePlatform,
  ChromeStableVersions,
  ChromeSupportAssessment,
  ChromeSupportPolicy
} from '../src/extension/chrome-support.js'

export type ChromeSupportCache = {
  schemaVersion: 1
  checkedAt: string
  platforms: ChromePlatform[]
  minimumMajor: number
  stableVersions: Record<ChromePlatform, string>
}

export type ChromeStableObservation = {
  source: 'cache' | 'network'
  checkedAt: string
  stableVersions: Record<ChromePlatform, string>
  cacheWriteError?: string
}

export type ObserveChromeStableOptions = {
  policy: ChromeSupportPolicy
  now: Date
  forceFresh: boolean
  persistNetworkCache?: boolean
  readCache: () => Promise<unknown>
  writeCache: (cache: ChromeSupportCache) => Promise<void>
  fetchVersionHistory: (platform: ChromePlatform) => Promise<unknown>
}

export type ChromeSupportCommand = 'check' | 'status' | 'bump' | 'release-check'

export type ChromeSupportCommandDependencies = {
  policy: ChromeSupportPolicy
  now: Date
  readManifest: () => Promise<unknown>
  readCache: () => Promise<unknown>
  writeCache: (cache: ChromeSupportCache) => Promise<void>
  fetchVersionHistory: (platform: ChromePlatform) => Promise<unknown>
  writePolicy: (policy: ChromeSupportPolicy) => Promise<void>
  log: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export const CHROME_SUPPORT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertGeneratedManifestMatchesPolicy(
  value: unknown,
  policy: ChromeSupportPolicy
): void {
  const expected = String(policy.minimumMajor)
  if (!isRecord(value) || value.minimum_chrome_version !== expected) {
    throw new Error(
      `extension/manifest.json must set minimum_chrome_version to ${expected}; run pnpm build`
    )
  }
}

function parseChromeSupportCache(
  value: unknown,
  policy: ChromeSupportPolicy
): ChromeSupportCache | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.checkedAt !== 'string' ||
      value.minimumMajor !== policy.minimumMajor) {
    return null
  }
  const cachePlatforms = value.platforms
  const cacheVersions = value.stableVersions
  const checkedAtMs = Date.parse(value.checkedAt)
  if (Number.isNaN(checkedAtMs) || !Array.isArray(cachePlatforms) ||
      cachePlatforms.length !== policy.platforms.length ||
      !policy.platforms.every((platform) => cachePlatforms.includes(platform)) ||
      !isRecord(cacheVersions)) {
    return null
  }

  const stableVersions = {} as Record<ChromePlatform, string>
  for (const platform of policy.platforms) {
    const version = cacheVersions[platform]
    if (typeof version !== 'string') return null
    try {
      chromeMajor(version)
    } catch {
      return null
    }
    stableVersions[platform] = version
  }

  return {
    schemaVersion: 1,
    checkedAt: value.checkedAt,
    platforms: [...policy.platforms],
    minimumMajor: policy.minimumMajor,
    stableVersions
  }
}

export function isChromeSupportCacheFresh(
  value: unknown,
  policy: ChromeSupportPolicy,
  now: Date,
  ttlMs = CHROME_SUPPORT_CACHE_TTL_MS
): boolean {
  const cache = parseChromeSupportCache(value, policy)
  if (!cache) return false
  const ageMs = now.getTime() - Date.parse(cache.checkedAt)
  return ageMs >= 0 && ageMs < ttlMs
}

export async function observeChromeStable(
  options: ObserveChromeStableOptions
): Promise<ChromeStableObservation> {
  const cachedValue = await options.readCache()
  const cache = parseChromeSupportCache(cachedValue, options.policy)
  if (!options.forceFresh && cache &&
      isChromeSupportCacheFresh(cache, options.policy, options.now)) {
    return {
      source: 'cache',
      checkedAt: cache.checkedAt,
      stableVersions: cache.stableVersions
    }
  }

  const versionEntries = await Promise.all(
    options.policy.platforms.map(async (platform) => {
      const response = await options.fetchVersionHistory(platform)
      return [platform, parseLatestStableVersion(response, platform)] as const
    })
  )
  const stableVersions = Object.fromEntries(versionEntries) as Record<ChromePlatform, string>
  const refreshedCache: ChromeSupportCache = {
    schemaVersion: 1,
    checkedAt: options.now.toISOString(),
    platforms: [...options.policy.platforms],
    minimumMajor: options.policy.minimumMajor,
    stableVersions
  }
  let cacheWriteError: string | undefined
  if (options.persistNetworkCache !== false) {
    try {
      await options.writeCache(refreshedCache)
    } catch (error) {
      cacheWriteError = errorMessage(error)
    }
  }
  return {
    source: 'network',
    checkedAt: refreshedCache.checkedAt,
    stableVersions,
    ...(cacheWriteError ? { cacheWriteError } : {})
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatStableVersions(
  policy: ChromeSupportPolicy,
  versions: Readonly<Record<string, string>>
): string {
  return policy.platforms.map((platform) => `${platform}=${versions[platform]}`).join(', ')
}

async function persistObservationCache(
  dependencies: ChromeSupportCommandDependencies,
  policy: ChromeSupportPolicy,
  observation: ChromeStableObservation
): Promise<void> {
  try {
    await dependencies.writeCache({
      schemaVersion: 1,
      checkedAt: observation.checkedAt,
      platforms: [...policy.platforms],
      minimumMajor: policy.minimumMajor,
      stableVersions: observation.stableVersions
    })
  } catch (error) {
    dependencies.warn(
      `The official check succeeded, but the optional observation cache was not updated: ` +
      errorMessage(error)
    )
  }
}

export async function runChromeSupportCommand(
  command: ChromeSupportCommand,
  dependencies: ChromeSupportCommandDependencies
): Promise<number> {
  try {
    assertGeneratedManifestMatchesPolicy(await dependencies.readManifest(), dependencies.policy)
  } catch (error) {
    dependencies.error(`Chrome support consistency check failed: ${errorMessage(error)}`)
    return 1
  }

  if (command === 'check') {
    dependencies.log(
      `Chrome support is internally consistent at Chrome ${dependencies.policy.minimumMajor}.`
    )
    return 0
  }

  let observation: ChromeStableObservation
  try {
    observation = await observeChromeStable({
      policy: dependencies.policy,
      now: dependencies.now,
      forceFresh: command !== 'status',
      persistNetworkCache: command !== 'bump',
      readCache: dependencies.readCache,
      writeCache: dependencies.writeCache,
      fetchVersionHistory: dependencies.fetchVersionHistory
    })
  } catch (error) {
    const detail = errorMessage(error)
    if (command === 'status') {
      dependencies.warn(
        `Could not refresh Chrome Stable versions (${detail}); support freshness is unknown. ` +
        `The offline consistency check passed.`
      )
      return 0
    }
    dependencies.error(`A fresh Chrome Stable check is required but failed: ${detail}`)
    return 1
  }

  dependencies.log(
    `Chrome Stable (${observation.source}, checked ${observation.checkedAt}): ` +
    formatStableVersions(dependencies.policy, observation.stableVersions)
  )
  if (observation.cacheWriteError) {
    dependencies.warn(
      `The official check succeeded, but the optional observation cache was not updated: ` +
      observation.cacheWriteError
    )
  }
  const assessment = assessChromeSupport(dependencies.policy, observation.stableVersions)
  if (assessment.status === 'unsupported') {
    dependencies.error(
      `Chrome ${assessment.committedMinimumMajor} is above the safe cross-platform floor ` +
      `${assessment.desiredMinimumMajor}. Review the policy instead of downgrading automatically.`
    )
    return 1
  }
  if (assessment.status === 'current') {
    if (command === 'bump') {
      await persistObservationCache(dependencies, dependencies.policy, observation)
    }
    dependencies.log(
      `Chrome ${assessment.committedMinimumMajor} remains the latest-two support floor.`
    )
    return 0
  }

  if (command === 'status') {
    dependencies.warn(
      `Chrome support can advance from ${assessment.committedMinimumMajor} to ` +
      `${assessment.desiredMinimumMajor}; run pnpm chrome-support:bump and review the diff.`
    )
    return 0
  }
  if (command === 'release-check') {
    dependencies.error(
      `Chrome support is stale: expected ${assessment.desiredMinimumMajor}, ` +
      `found ${assessment.committedMinimumMajor}. Run pnpm chrome-support:bump.`
    )
    return 1
  }

  const bumpedPolicy = createBumpedChromeSupportPolicy(
    dependencies.policy,
    observation.stableVersions,
    dependencies.now
  )
  if (!bumpedPolicy) return 0
  await dependencies.writePolicy(bumpedPolicy)
  await persistObservationCache(dependencies, bumpedPolicy, observation)
  dependencies.log(
    `Updated chrome-support.json from Chrome ${assessment.committedMinimumMajor} to ` +
    `${assessment.desiredMinimumMajor}. Review the generated diff before committing.`
  )
  return 0
}

async function resolveChromeSupportCachePath(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    return join(resolve(REPO_ROOT, stdout.trim()), 'tab-out-cache', 'chrome-stable.json')
  } catch {
    return join(tmpdir(), 'tab-out', 'chrome-stable.json')
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readOptionalJsonFile(path: string): Promise<unknown> {
  try {
    return await readJsonFile(path)
  } catch {
    return null
  }
}

async function writeJsonFileAtomically(
  path: string,
  value: unknown,
  mode: number
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export function chromeVersionHistoryUrl(platform: ChromePlatform): string {
  return `${VERSION_HISTORY_BASE_URL}/${platform}/channels/stable/versions?` +
    'page_size=1&order_by=version%20desc'
}

async function fetchVersionHistory(platform: ChromePlatform): Promise<unknown> {
  const response = await fetch(chromeVersionHistoryUrl(platform), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(VERSION_HISTORY_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`VersionHistory ${platform} request failed with HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

function parseCommand(value: string | undefined): ChromeSupportCommand | null {
  if (value === 'check' || value === 'status' || value === 'bump' || value === 'release-check') {
    return value
  }
  return null
}

export async function chromeSupportMain(argv = process.argv.slice(2)): Promise<number> {
  const command = argv.length === 1 ? parseCommand(argv[0]) : null
  if (!command) {
    console.error('Usage: chrome-support.ts <check|status|bump|release-check>')
    return 2
  }

  let cachePathPromise: Promise<string> | undefined
  const cachePath = () => {
    cachePathPromise ??= resolveChromeSupportCachePath()
    return cachePathPromise
  }
  return runChromeSupportCommand(command, {
    policy: chromeSupportPolicy,
    now: new Date(),
    readManifest: () => readJsonFile(MANIFEST_FILE),
    readCache: async () => readOptionalJsonFile(await cachePath()),
    writeCache: async (cache) => writeJsonFileAtomically(await cachePath(), cache, 0o600),
    fetchVersionHistory,
    writePolicy: (policy) => writeJsonFileAtomically(POLICY_FILE, policy, 0o644),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message)
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  chromeSupportMain()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}
