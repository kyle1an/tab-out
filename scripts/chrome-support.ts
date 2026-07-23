import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CHROME_PLATFORMS,
  assessChromeSupport,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  parseLatestStableVersion,
  type ChromePlatform,
  type ChromeStableVersions,
  type ChromeSupportPolicy
} from '../src/extension/chrome-support.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const POLICY_FILE = join(REPO_ROOT, 'chrome-support.json')
const MANIFEST_FILE = join(REPO_ROOT, 'extension/manifest.json')
const VERSION_HISTORY_BASE_URL = 'https://versionhistory.googleapis.com/v1/chrome/platforms'
const VERSION_HISTORY_TIMEOUT_MS = 5_000

type ChromeSupportCommand = 'check' | 'bump' | 'release-check'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

async function observeChromeStable(): Promise<ChromeStableVersions> {
  const entries = await Promise.all(
    CHROME_PLATFORMS.map(async (platform) => [
      platform,
      parseLatestStableVersion(await fetchVersionHistory(platform), platform)
    ] as const)
  )
  return Object.fromEntries(entries) as Record<ChromePlatform, string>
}

function formatStableVersions(versions: ChromeStableVersions): string {
  return CHROME_PLATFORMS.map((platform) => `${platform}=${versions[platform]}`).join(', ')
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function assertManifestIsCurrent(): Promise<void> {
  assertGeneratedManifestMatchesPolicy(await readJsonFile(MANIFEST_FILE), chromeSupportPolicy)
}

async function observeAndReport() {
  const stableVersions = await observeChromeStable()
  console.log(`Chrome Stable: ${formatStableVersions(stableVersions)}`)
  return {
    stableVersions,
    assessment: assessChromeSupport(chromeSupportPolicy, stableVersions)
  }
}

async function runCheck(): Promise<void> {
  await assertManifestIsCurrent()
  console.log(`Chrome support is internally consistent at Chrome ${chromeSupportPolicy.minimumMajor}.`)
}

async function runReleaseCheck(): Promise<void> {
  await assertManifestIsCurrent()
  const { assessment } = await observeAndReport()
  if (assessment.status === 'unsupported') {
    throw new Error(
      `Chrome ${assessment.committedMinimumMajor} is above the safe cross-platform floor ` +
      `${assessment.desiredMinimumMajor}; review the policy instead of lowering it automatically.`
    )
  }
  if (assessment.status === 'behind') {
    throw new Error(
      `Chrome support is stale: expected ${assessment.desiredMinimumMajor}, ` +
      `found ${assessment.committedMinimumMajor}. Run pnpm chrome-support:bump.`
    )
  }
  console.log(`Chrome ${assessment.committedMinimumMajor} remains the latest-two support floor.`)
}

async function runBump(): Promise<void> {
  await assertManifestIsCurrent()
  const { stableVersions, assessment } = await observeAndReport()
  if (assessment.status === 'unsupported') {
    throw new Error(
      `Chrome ${assessment.committedMinimumMajor} is above the safe cross-platform floor ` +
      `${assessment.desiredMinimumMajor}; review the policy instead of lowering it automatically.`
    )
  }
  if (assessment.status === 'current') {
    console.log(`Chrome ${assessment.committedMinimumMajor} remains the latest-two support floor.`)
    return
  }

  const bumpedPolicy = createBumpedChromeSupportPolicy(
    chromeSupportPolicy,
    stableVersions,
    new Date()
  )
  if (!bumpedPolicy) return
  await writeFile(POLICY_FILE, `${JSON.stringify(bumpedPolicy, null, 2)}\n`, 'utf8')
  console.log(
    `Updated chrome-support.json from Chrome ${assessment.committedMinimumMajor} to ` +
    `${assessment.desiredMinimumMajor}. Review the generated diff before committing.`
  )
}

function parseCommand(value: string | undefined): ChromeSupportCommand | null {
  return value === 'check' || value === 'bump' || value === 'release-check' ? value : null
}

export async function chromeSupportMain(argv = process.argv.slice(2)): Promise<number> {
  const command = argv.length === 1 ? parseCommand(argv[0]) : null
  if (!command) {
    console.error('Usage: chrome-support.ts <check|bump|release-check>')
    return 2
  }

  try {
    if (command === 'check') await runCheck()
    else if (command === 'bump') await runBump()
    else await runReleaseCheck()
    return 0
  } catch (error) {
    console.error(`Chrome support check failed: ${errorMessage(error)}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  chromeSupportMain().then((exitCode) => {
    process.exitCode = exitCode
  })
}
