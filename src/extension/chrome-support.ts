import { Schema } from 'effect'
import rawChromeSupportPolicy from '../../chrome-support.json' with { type: 'json' }

export const CHROME_PLATFORMS = [
  'win',
  'win64',
  'win_arm64',
  'mac',
  'mac_arm64',
  'linux'
] as const

export type ChromePlatform = (typeof CHROME_PLATFORMS)[number]

const chromeStableVersionsSchema = Schema.Record(
  Schema.Literals(CHROME_PLATFORMS),
  Schema.String
)

export type ChromeStableVersions = typeof chromeStableVersionsSchema.Type

const chromeSupportPolicySchema = Schema.Struct({
  minimumMajor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lastBumpedAt: Schema.String
})

export type ChromeSupportPolicy = typeof chromeSupportPolicySchema.Type

export type ChromeSupportAssessment = {
  status: 'current' | 'behind' | 'unsupported'
  committedMinimumMajor: number
  desiredMinimumMajor: number
}

const CHROME_VERSION_PATTERN = /^(\d+)\./

const chromeVersionHistoryEnvelopeSchema = Schema.Struct({
  versions: Schema.Array(Schema.Unknown)
})

const chromeVersionCandidateSchema = Schema.Struct({
  version: Schema.String
})

const isChromeStableVersionsSchema = Schema.is(chromeStableVersionsSchema)
const isChromeSupportPolicy = Schema.is(chromeSupportPolicySchema)
const isChromeVersionHistoryEnvelope = Schema.is(chromeVersionHistoryEnvelopeSchema)
const isChromeVersionCandidate = Schema.is(chromeVersionCandidateSchema)

function chromeMajor(version: string): number {
  const match = CHROME_VERSION_PATTERN.exec(version)
  if (!match) throw new TypeError(`Invalid Chrome version: ${version}`)
  return Number(match[1])
}

export function deriveMinimumChromeMajor(versions: ChromeStableVersions): number {
  return Math.min(...CHROME_PLATFORMS.map((platform) => chromeMajor(versions[platform]))) - 1
}

export function isChromeStableVersions(value: unknown): value is ChromeStableVersions {
  return isChromeStableVersionsSchema(value)
}

export function parseLatestStableVersion(value: unknown, platform: string): string {
  if (!isChromeVersionHistoryEnvelope(value)) {
    throw new TypeError(`Chrome VersionHistory returned no Stable version for ${platform}`)
  }
  const first = value.versions[0]
  if (!isChromeVersionCandidate(first)) {
    throw new TypeError(`Chrome VersionHistory returned no Stable version for ${platform}`)
  }
  chromeMajor(first.version)
  return first.version
}

export function assessChromeSupport(
  policy: ChromeSupportPolicy,
  versions: ChromeStableVersions
): ChromeSupportAssessment {
  const desiredMinimumMajor = deriveMinimumChromeMajor(versions)
  const status = policy.minimumMajor === desiredMinimumMajor
    ? 'current'
    : policy.minimumMajor < desiredMinimumMajor
      ? 'behind'
      : 'unsupported'
  return {
    status,
    committedMinimumMajor: policy.minimumMajor,
    desiredMinimumMajor
  }
}

export function createBumpedChromeSupportPolicy(
  policy: ChromeSupportPolicy,
  versions: ChromeStableVersions,
  now: Date
): ChromeSupportPolicy | null {
  const assessment = assessChromeSupport(policy, versions)
  if (assessment.status === 'current') return null
  if (assessment.status === 'unsupported') {
    throw new Error(
      `Chrome support policy is ahead of the official cross-platform floor; ` +
      `refusing to lower ${policy.minimumMajor} to ${assessment.desiredMinimumMajor}`
    )
  }
  return {
    minimumMajor: assessment.desiredMinimumMajor,
    lastBumpedAt: now.toISOString().slice(0, 10)
  }
}

if (!isChromeSupportPolicy(rawChromeSupportPolicy)) {
  throw new TypeError('chrome-support.json must contain minimumMajor and lastBumpedAt')
}

export const chromeSupportPolicy: ChromeSupportPolicy = rawChromeSupportPolicy
export const MINIMUM_CHROME_VERSION = String(chromeSupportPolicy.minimumMajor)
export const CHROME_BUILD_TARGET = `chrome${chromeSupportPolicy.minimumMajor}` as const
