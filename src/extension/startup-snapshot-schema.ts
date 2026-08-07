import { Result, Schema } from 'effect'

import { domainCardId } from './domain-card-id.js'
import { pageIdentityForWorkingSet } from './working-set.js'

export type DashboardStartupTitleRetention = {
  tabId: number
  url: string
  title: string
  kind: 'suspended' | 'retained-loading'
}

type DashboardStartupWorkingSetPriority = {
  epoch: number
  keys: readonly string[]
}

export type DashboardStartupSeedBoundary = {
  schemaVersion: 2
  savedAt: number
  captureStartedAt: number
  cardOrder: readonly string[]
  workingSetPriority: DashboardStartupWorkingSetPriority
  titleRetention?: readonly DashboardStartupTitleRetention[]
}

const startupTitleRetentionSchema = Schema.Struct({
  tabId: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(['suspended', 'retained-loading'])
}) satisfies Schema.Schema<DashboardStartupTitleRetention>

const dashboardStartupSeedBoundarySchema = Schema.Struct({
  schemaVersion: Schema.Literals([2]),
  savedAt: Schema.Finite,
  captureStartedAt: Schema.Finite,
  cardOrder: Schema.Array(Schema.String),
  workingSetPriority: Schema.Struct({
    epoch: Schema.Finite,
    keys: Schema.Array(Schema.String)
  }),
  titleRetention: Schema.optionalKey(Schema.Array(startupTitleRetentionSchema))
})

const decodeDashboardStartupSeedBoundary = Schema.decodeUnknownResult(
  dashboardStartupSeedBoundarySchema
)

function normalizeCardOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    if (!value.startsWith('domain-')) continue
    let domain = ''
    try {
      domain = decodeURIComponent(value.slice('domain-'.length))
    } catch {
      continue
    }
    if (!domain || domainCardId(domain) !== value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

function normalizeWorkingSetPriorityKeys(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const key = pageIdentityForWorkingSet(value)
    if (!key || key !== value || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

function titleIsUsable(title: string): boolean {
  return !!title.replaceAll('\u200E', '').trim()
}

function normalizeTitleRetention(
  values: readonly DashboardStartupTitleRetention[]
): DashboardStartupTitleRetention[] {
  const seenTabIds = new Set<number>()
  const normalized: DashboardStartupTitleRetention[] = []
  for (const value of values) {
    if (
      value.tabId < 0 ||
      seenTabIds.has(value.tabId) ||
      !URL.parse(value.url) ||
      !titleIsUsable(value.title)
    ) continue
    seenTabIds.add(value.tabId)
    normalized.push(value)
  }
  return normalized
}

export function parseDashboardStartupSeedBoundary(
  value: unknown,
  includeTitleRetention = true
): DashboardStartupSeedBoundary | null {
  const result = decodeDashboardStartupSeedBoundary(value)
  if (Result.isFailure(result)) return null
  const seed = result.success
  const titleRetention = includeTitleRetention
    ? normalizeTitleRetention(seed.titleRetention ?? [])
    : []
  return {
    schemaVersion: 2,
    savedAt: seed.savedAt,
    captureStartedAt: seed.captureStartedAt,
    cardOrder: normalizeCardOrder(seed.cardOrder),
    workingSetPriority: {
      epoch: seed.workingSetPriority.epoch,
      keys: normalizeWorkingSetPriorityKeys(seed.workingSetPriority.keys)
    },
    ...(titleRetention.length > 0 ? { titleRetention } : {})
  }
}

const legacyTabCandidateSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  url: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
  suspended: Schema.optionalKey(Schema.Unknown),
  retainedSuspendedTitle: Schema.optionalKey(Schema.Unknown)
})

const legacyDomainGroupCandidateSchema = Schema.Struct({
  domain: Schema.optionalKey(Schema.Unknown)
})

const legacyWorkingSetCandidateSchema = Schema.Struct({
  items: Schema.Array(Schema.Unknown)
})

const legacyWorkingSetItemCandidateSchema = Schema.Struct({
  key: Schema.optionalKey(Schema.Unknown),
  tabUrl: Schema.optionalKey(Schema.Unknown)
})

const legacyDashboardStartupBoundarySchema = Schema.Struct({
  savedAt: Schema.Finite,
  captureStartedAt: Schema.optionalKey(Schema.Unknown),
  workingSetSavedAt: Schema.optionalKey(Schema.Unknown),
  snapshot: Schema.Struct({
    dashboard: Schema.Struct({
      realTabs: Schema.Array(legacyTabCandidateSchema),
      domainGroups: Schema.Array(legacyDomainGroupCandidateSchema)
    }),
    workingSet: Schema.optionalKey(Schema.Unknown)
  })
})

const isLegacyDashboardStartupBoundary = Schema.is(legacyDashboardStartupBoundarySchema)
const isLegacyWorkingSetCandidate = Schema.is(legacyWorkingSetCandidateSchema)
const isLegacyWorkingSetItemCandidate = Schema.is(legacyWorkingSetItemCandidateSchema)

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function legacyWorkingSetPriorityKeys(value: unknown): string[] {
  if (!isLegacyWorkingSetCandidate(value)) return []
  return normalizeWorkingSetPriorityKeys(value.items.flatMap((item) => {
    if (!isLegacyWorkingSetItemCandidate(item)) return []
    const candidate = typeof item.key === 'string'
      ? item.key
      : typeof item.tabUrl === 'string' ? item.tabUrl : ''
    const key = pageIdentityForWorkingSet(candidate)
    return key ? [key] : []
  }))
}

function legacyTitleRetention(
  tabs: typeof legacyDashboardStartupBoundarySchema.Type['snapshot']['dashboard']['realTabs']
): DashboardStartupTitleRetention[] {
  return normalizeTitleRetention(tabs.flatMap((tab) => {
    if (
      typeof tab.id !== 'number' ||
      !Number.isInteger(tab.id) ||
      typeof tab.url !== 'string' ||
      typeof tab.title !== 'string'
    ) return []
    const kind: DashboardStartupTitleRetention['kind'] | null =
      tab.retainedSuspendedTitle === true
        ? 'retained-loading'
        : tab.suspended === true ? 'suspended' : null
    return kind ? [{ tabId: tab.id, url: tab.url, title: tab.title, kind }] : []
  }))
}

/**
 * Read-only bridge for the former render cache. Only continuity seed fields are
 * inspected; history, closed rows, preferences, and derived view models are ignored.
 */
export function deriveDashboardStartupSeedFromLegacyBoundary(
  value: unknown,
  includeTitleRetention = true
): DashboardStartupSeedBoundary | null {
  if (!isLegacyDashboardStartupBoundary(value)) return null
  const captureStartedAt = finiteNumberOr(value.captureStartedAt, value.savedAt)
  const titleRetention = includeTitleRetention
    ? legacyTitleRetention(value.snapshot.dashboard.realTabs)
    : []
  return {
    schemaVersion: 2,
    savedAt: value.savedAt,
    captureStartedAt,
    cardOrder: normalizeCardOrder(value.snapshot.dashboard.domainGroups.flatMap((group) =>
      typeof group.domain === 'string' ? [domainCardId(group.domain)] : []
    )),
    workingSetPriority: {
      epoch: finiteNumberOr(value.workingSetSavedAt, value.savedAt),
      keys: legacyWorkingSetPriorityKeys(value.snapshot.workingSet)
    },
    ...(titleRetention.length > 0 ? { titleRetention } : {})
  }
}
