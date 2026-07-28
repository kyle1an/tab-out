import { cruise, type ICruiseResult } from 'dependency-cruiser'
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import rawDependencyBaseline from '../.dependency-cruiser-known-violations.json' with { type: 'json' }

const CONFIG_FILE = '.dependency-cruiser.cjs'
const BASELINE_FILE = '.dependency-cruiser-known-violations.json'

export type DependencyBaselineViolation = {
  type: string
  from: string
  to?: string
  rule: {
    severity: string
    name: string
  }
  [key: string]: unknown
}

export type DependencyBaselineDiff = {
  unexpected: DependencyBaselineViolation[]
  stale: DependencyBaselineViolation[]
}

function pathMemberNames(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) =>
    entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined
  )
}

function hasSamePathMembers(left: unknown, right: unknown): boolean {
  const leftNames = pathMemberNames(left)
  const rightNames = pathMemberNames(right)
  if (!leftNames || !rightNames || leftNames.length !== rightNames.length) return false
  return leftNames.every((name) => rightNames.includes(name))
}

function isSameViolation(
  left: DependencyBaselineViolation,
  right: DependencyBaselineViolation
): boolean {
  if (left.rule.name !== right.rule.name) return false
  if (left.cycle !== undefined && right.cycle !== undefined) {
    return hasSamePathMembers(left.cycle, right.cycle)
  }
  if (left.via !== undefined && right.via !== undefined) {
    return left.from === right.from && left.to === right.to && hasSamePathMembers(left.via, right.via)
  }
  return left.from === right.from && left.to === right.to
}

export function compareDependencyBaselines(
  current: DependencyBaselineViolation[],
  known: DependencyBaselineViolation[]
): DependencyBaselineDiff {
  return {
    unexpected: current.filter(
      (currentViolation) => !known.some((knownViolation) => isSameViolation(currentViolation, knownViolation))
    ),
    stale: known.filter(
      (knownViolation) => !current.some((currentViolation) => isSameViolation(currentViolation, knownViolation))
    )
  }
}

function parseBaseline(value: unknown): DependencyBaselineViolation[] {
  if (!Array.isArray(value)) throw new TypeError('Dependency architecture baseline must be a JSON array')
  return value as DependencyBaselineViolation[]
}

function formatViolation(violation: DependencyBaselineViolation): string {
  return `${violation.rule.name}: ${violation.from}${violation.to ? ` -> ${violation.to}` : ''}`
}

export async function checkDependencyArchitecture(): Promise<number> {
  const options = await extractDepcruiseOptions(`./${CONFIG_FILE}`)
  const tsConfigFileName = options.tsConfig?.fileName
  const tsConfig = tsConfigFileName ? extractTSConfig(tsConfigFileName) : undefined
  const report = await cruise(
    ['src'],
    { ...options, outputType: 'json' },
    {},
    tsConfig ? { tsConfig } : undefined
  )
  const result = (typeof report.output === 'string' ? JSON.parse(report.output) : report.output) as ICruiseResult
  const current = result.summary.violations as DependencyBaselineViolation[]
  const known = parseBaseline(rawDependencyBaseline)
  const diff = compareDependencyBaselines(current, known)

  if (diff.unexpected.length === 0 && diff.stale.length === 0) {
    console.log(
      `Dependency architecture baseline matches: ${known.length} known violations; ` +
      `${result.summary.totalCruised} modules and ${result.summary.totalDependenciesCruised} dependencies cruised.`
    )
    return 0
  }

  console.error('Dependency architecture baseline drift detected.')
  if (diff.unexpected.length > 0) {
    console.error('\nUnexpected violations:')
    for (const violation of diff.unexpected) console.error(`- ${formatViolation(violation)}`)
  }
  if (diff.stale.length > 0) {
    console.error('\nStale baseline entries:')
    for (const violation of diff.stale) console.error(`- ${formatViolation(violation)}`)
  }
  console.error(`\nReview the graph before updating ${BASELINE_FILE}.`)
  return 1
}

if (import.meta.main) {
  checkDependencyArchitecture()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}
