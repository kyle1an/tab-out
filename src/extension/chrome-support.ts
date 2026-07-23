import rawChromeSupportPolicy from '../../chrome-support.json' with { type: 'json' }

export type ChromeStableVersions = Readonly<Record<string, string>>

export const CHROME_PLATFORMS = [
  'win',
  'win64',
  'win_arm64',
  'mac',
  'mac_arm64',
  'linux'
] as const

export type ChromePlatform = (typeof CHROME_PLATFORMS)[number]

export type ChromeSupportPolicy = {
  schemaVersion: 1
  policy: 'latest-two-stable-majors'
  platforms: ChromePlatform[]
  minimumMajor: number
  lastBumpedAt: string
  stableVersionsAtLastBump: Record<ChromePlatform, string>
}

export type ChromeSupportAssessment = {
  status: 'current' | 'behind' | 'unsupported'
  committedMinimumMajor: number
  desiredMinimumMajor: number
}

const CHROME_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/

function chromeVersionParts(version: string): [number, number, number, number] {
  const match = CHROME_VERSION_PATTERN.exec(version)
  if (!match) throw new TypeError(`Invalid Chrome version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
}

export function chromeMajor(version: string): number {
  return chromeVersionParts(version)[0]
}

export function deriveMinimumChromeMajor(versions: ChromeStableVersions): number {
  const majors = Object.values(versions).map(chromeMajor)
  if (majors.length === 0) throw new TypeError('At least one supported platform is required')
  return Math.min(...majors) - 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseLatestStableVersion(value: unknown, platform: string): string {
  if (!isRecord(value) || !Array.isArray(value.versions)) {
    throw new TypeError(`Chrome VersionHistory returned no valid Stable versions for ${platform}`)
  }

  const versions = value.versions.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.version !== 'string') return []
    try {
      return [{ version: entry.version, parts: chromeVersionParts(entry.version) }]
    } catch {
      return []
    }
  })
  if (versions.length === 0) {
    throw new TypeError(`Chrome VersionHistory returned no valid Stable versions for ${platform}`)
  }
  versions.sort((left, right) => {
    for (let index = 0; index < left.parts.length; index += 1) {
      const difference = right.parts[index] - left.parts[index]
      if (difference !== 0) return difference
    }
    return 0
  })
  return versions[0].version
}

function selectSupportedVersions(
  versions: ChromeStableVersions,
  platforms: readonly ChromePlatform[]
): Record<ChromePlatform, string> {
  const selected = {} as Record<ChromePlatform, string>
  for (const platform of platforms) {
    const version = versions[platform]
    if (typeof version !== 'string') {
      throw new TypeError(`Chrome Stable snapshot is missing ${platform}`)
    }
    chromeMajor(version)
    selected[platform] = version
  }
  return selected
}

export function assessChromeSupport(
  policy: ChromeSupportPolicy,
  versions: ChromeStableVersions
): ChromeSupportAssessment {
  const desiredMinimumMajor = deriveMinimumChromeMajor(
    selectSupportedVersions(versions, policy.platforms)
  )
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
    ...policy,
    minimumMajor: assessment.desiredMinimumMajor,
    lastBumpedAt: now.toISOString().slice(0, 10),
    stableVersionsAtLastBump: selectSupportedVersions(versions, policy.platforms)
  }
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function validateChromeSupportPolicy(value: unknown): ChromeSupportPolicy {
  if (!isRecord(value)) throw new TypeError('Chrome support policy must be an object')
  if (value.schemaVersion !== 1) throw new TypeError('Chrome support policy schemaVersion must be 1')
  if (value.policy !== 'latest-two-stable-majors') {
    throw new TypeError('Chrome support policy must be latest-two-stable-majors')
  }
  const platforms = value.platforms
  if (!Array.isArray(platforms) ||
      platforms.length !== CHROME_PLATFORMS.length ||
      !CHROME_PLATFORMS.every((platform) => platforms.includes(platform))) {
    throw new TypeError(`Chrome support platforms must be ${CHROME_PLATFORMS.join(', ')}`)
  }
  if (!Number.isInteger(value.minimumMajor) || Number(value.minimumMajor) < 1) {
    throw new TypeError('Chrome support minimumMajor must be a positive integer')
  }
  if (!isIsoDate(value.lastBumpedAt)) {
    throw new TypeError('Chrome support lastBumpedAt must be an ISO date')
  }
  const snapshotValue = value.stableVersionsAtLastBump
  if (!isRecord(snapshotValue)) {
    throw new TypeError('Chrome support stableVersionsAtLastBump must be an object')
  }

  const stableVersionsAtLastBump = Object.fromEntries(
    CHROME_PLATFORMS.map((platform) => {
      const version = snapshotValue[platform]
      if (typeof version !== 'string') {
        throw new TypeError(`Chrome support snapshot is missing ${platform}`)
      }
      chromeMajor(version)
      return [platform, version]
    })
  ) as Record<ChromePlatform, string>
  const expectedMinimum = deriveMinimumChromeMajor(stableVersionsAtLastBump)
  if (value.minimumMajor !== expectedMinimum) {
    throw new TypeError(`Chrome support minimumMajor must be ${expectedMinimum} for its last-bump snapshot`)
  }

  return {
    schemaVersion: 1,
    policy: 'latest-two-stable-majors',
    platforms: [...CHROME_PLATFORMS],
    minimumMajor: Number(value.minimumMajor),
    lastBumpedAt: value.lastBumpedAt,
    stableVersionsAtLastBump
  }
}

export const chromeSupportPolicy = validateChromeSupportPolicy(rawChromeSupportPolicy)
export const MINIMUM_CHROME_VERSION = String(chromeSupportPolicy.minimumMajor)
export const CHROME_BUILD_TARGET = `chrome${chromeSupportPolicy.minimumMajor}` as const
