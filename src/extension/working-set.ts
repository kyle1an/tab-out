import type {
  DashboardTab,
  WorkingSetActivityEvent,
  WorkingSetActivityKind,
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
  WorkingSetItem,
  WorkingSetSnapshot
} from './types'
import { compareNumericText } from './numeric-sort.js'
import { unwrapSuspenderUrl } from './suspension.js'
import { pickTabFavicon } from './favicons.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'

export const WORKING_SET_DEFAULT_LIMIT = 8
export const WORKING_SET_EXPANDED_LIMIT = 16
const WORKING_SET_MIN_ITEMS = 3

const WORKING_SET_ACTIVITY_VERSION = 1
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAME_DAY_MS = 24 * 60 * 60 * 1000
const CURRENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EVENTS_PER_RECORD = 80

const NOISY_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source'
])
type WorkingSetActivityInput = {
  kind: WorkingSetActivityKind
  at: number
  tab: Pick<DashboardTab, 'url' | 'rawUrl' | 'title'>
}

type WorkingSetSnapshotOptions = {
  tabs: DashboardTab[]
  activity: WorkingSetActivityStore | null | undefined
  now?: number
  defaultLimit?: number
  expandedLimit?: number
  minItems?: number
  currentWindowId?: number | null
}

function cloneStore(store: WorkingSetActivityStore): WorkingSetActivityStore {
  return {
    version: WORKING_SET_ACTIVITY_VERSION,
    records: Object.fromEntries(
      Object.entries(store.records).map(([key, record]) => [
        key,
        {
          ...record,
          events: record.events.map((event) => ({ ...event }))
        }
      ])
    )
  }
}

export function emptyWorkingSetActivity(): WorkingSetActivityStore {
  return { version: WORKING_SET_ACTIVITY_VERSION, records: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeWorkingSetActivity(value: unknown, now = Date.now()): WorkingSetActivityStore {
  if (!isRecord(value) || value.version !== WORKING_SET_ACTIVITY_VERSION || !isRecord(value.records)) {
    return emptyWorkingSetActivity()
  }

  const minAt = now - ACTIVITY_RETENTION_MS
  const records: Record<string, WorkingSetActivityRecord> = {}
  for (const [key, record] of Object.entries(value.records)) {
    if (!isRecord(record)) continue
    const normalizedKey = pageIdentityForWorkingSet(
      typeof record.url === 'string' ? record.url : key
    )
    if (!normalizedKey || normalizedKey !== key) continue
    const events = Array.isArray(record.events)
      ? record.events
          .filter((event): event is WorkingSetActivityEvent => (
            isRecord(event) &&
            (event.kind === 'activation' || event.kind === 'navigation') &&
            typeof event.at === 'number' &&
            Number.isFinite(event.at) &&
            event.at >= minAt
          ))
          .slice(-MAX_EVENTS_PER_RECORD)
      : []
    if (events.length === 0) continue
    const latestEvent = Math.max(...events.map((event) => event.at))
    const dismissedAt = typeof record.dismissedAt === 'number' && Number.isFinite(record.dismissedAt) ? record.dismissedAt : undefined
    const dismissedUntil = typeof record.dismissedUntil === 'number' && Number.isFinite(record.dismissedUntil) ? record.dismissedUntil : undefined
    const dismissalIsActive = (
      dismissedAt !== undefined &&
      dismissedUntil !== undefined &&
      dismissedUntil > now &&
      latestEvent <= dismissedAt
    )
    const lastActivatedAt = latestEventAt(events, 'activation')
    const lastNavigatedAt = latestEventAt(events, 'navigation')
    records[key] = {
      key,
      url: normalizedKey,
      title: String(record.title || ''),
      domain: typeof record.domain === 'string' && record.domain
        ? record.domain
        : domainForPageIdentity(normalizedKey),
      lastSeenAt: latestEvent,
      ...(lastActivatedAt === undefined ? {} : { lastActivatedAt }),
      ...(lastNavigatedAt === undefined ? {} : { lastNavigatedAt }),
      ...(dismissalIsActive ? { dismissedAt, dismissedUntil } : {}),
      events
    }
  }
  return { version: WORKING_SET_ACTIVITY_VERSION, records }
}

export function pageIdentityForWorkingSet(url = ''): string {
  const effectiveUrl = unwrapSuspenderUrl(url || '')
  if (!effectiveUrl) return ''

  const parsed = URL.parse(effectiveUrl)
  if (!parsed || isBrowserInternalUrl(parsed.href)) return ''
  if (isGoogleSearchResultPage(parsed)) return ''

  parsed.hash = ''
  const cleanParams = new URLSearchParams()
  const paramEntries = parsed.searchParams.entries()
    .filter(([name]) => !name.toLowerCase().startsWith('utm_') && !NOISY_QUERY_PARAMS.has(name.toLowerCase()))
    .toArray()
    .sort(([a], [b]) => a.localeCompare(b))
  for (const [name, value] of paramEntries) cleanParams.append(name, value)
  parsed.search = cleanParams.toString()

  if (parsed.protocol === 'file:') return parsed.href

  const pathname = parsed.pathname || '/'
  const path = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const query = parsed.search ? parsed.search : ''
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`
}

function isGoogleSearchResultPage(parsed: URL): boolean {
  return (
    (parsed.hostname === 'www.google.com' || parsed.hostname === 'google.com') &&
    parsed.pathname === '/search'
  )
}

export function recordWorkingSetActivity(
  store: Partial<WorkingSetActivityStore> | null | undefined,
  { kind, at, tab }: WorkingSetActivityInput
): WorkingSetActivityStore {
  const key = pageIdentityForWorkingSet(tab.url || tab.rawUrl || '')
  if (!key || !Number.isFinite(at)) return normalizeWorkingSetActivity(store, Number.isFinite(at) ? at : Date.now())

  const next = cloneStore(normalizeWorkingSetActivity(store, at))
  const existing = next.records[key]
  const events = [...(existing?.events || []), { kind, at }]
    .filter((event) => event.at >= at - ACTIVITY_RETENTION_MS)
    .slice(-MAX_EVENTS_PER_RECORD)
  next.records[key] = {
    key,
    url: key,
    title: tab.title || existing?.title || displayUrlForPageIdentity(key),
    domain: domainForPageIdentity(key),
    lastSeenAt: at,
    ...(kind === 'activation'
      ? { lastActivatedAt: at }
      : existing?.lastActivatedAt === undefined
        ? {}
        : { lastActivatedAt: existing.lastActivatedAt }),
    ...(kind === 'navigation'
      ? { lastNavigatedAt: at }
      : existing?.lastNavigatedAt === undefined
        ? {}
        : { lastNavigatedAt: existing.lastNavigatedAt }),
    events
  }
  return next
}

export function buildWorkingSetSnapshot({
  tabs,
  activity,
  now = Date.now(),
  defaultLimit = WORKING_SET_DEFAULT_LIMIT,
  expandedLimit = WORKING_SET_EXPANDED_LIMIT,
  minItems = WORKING_SET_MIN_ITEMS,
  currentWindowId = null
}: WorkingSetSnapshotOptions): WorkingSetSnapshot {
  const normalizedActivity = normalizeWorkingSetActivity(activity, now)
  const openByKey = new Map<string, DashboardTab[]>()

  for (const tab of tabs) {
    if (tab.isTabOut || tab.isApp || typeof tab.id !== 'number') continue
    const key = pageIdentityForWorkingSet(tab.url || tab.rawUrl || '')
    if (!key) continue
    openByKey.getOrInsertComputed(key, () => []).push(tab)
  }

  const domainActivity = new Map<string, number>()
  for (const record of Object.values(normalizedActivity.records)) {
    domainActivity.set(record.domain, (domainActivity.get(record.domain) || 0) + recentEventCount(record.events, now, CURRENT_WEEK_MS))
  }

  const items: WorkingSetItem[] = []
  for (const [key, groupedTabs] of openByKey) {
    const record = normalizedActivity.records[key]
    if (!record) continue
    if (isWorkingSetRecordDismissed(record, now)) continue
    const score = scoreWorkingSetRecord(record, now, domainActivity.get(record.domain) || 0)
    if (score <= 0) continue

    const representative = pickRepresentativeTab(groupedTabs, currentWindowId)
    if (!representative || typeof representative.id !== 'number') continue
    const url = representative.url || representative.rawUrl || record.url
    items.push({
      key,
      tabId: representative.id,
      windowId: representative.windowId,
      tabUrl: url,
      rawUrl: representative.rawUrl || url,
      title: representative.title || record.title || displayUrlForPageIdentity(key),
      displayUrl: displayUrlForPageIdentity(key),
      faviconUrl: pickTabFavicon({ favIconUrl: representative.favIconUrl, url, suspended: representative.suspended }),
      dupeCount: groupedTabs.length,
      active: !!representative.active,
      activeInOtherWindow: !!(representative.active && currentWindowId != null && representative.windowId !== currentWindowId),
      loading: groupedTabs.some((tab) => !tab.suspended && tab.status === 'loading'),
      audible: !!representative.audible,
      muted: !!representative.muted,
      score,
      lastActivatedAt: Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
    })
  }

  const rankedItems = items
    .sort((a, b) => b.score - a.score || compareNumericText(a.displayUrl, b.displayUrl))
    .slice(0, expandedLimit)

  return {
    defaultLimit,
    expandedLimit,
    items: rankedItems.length >= minItems ? rankedItems : []
  }
}

function isWorkingSetRecordDismissed(record: WorkingSetActivityRecord, now: number): boolean {
  if (
    typeof record.dismissedAt !== 'number' ||
    typeof record.dismissedUntil !== 'number' ||
    !Number.isFinite(record.dismissedAt) ||
    !Number.isFinite(record.dismissedUntil) ||
    record.dismissedUntil <= now
  ) {
    return false
  }

  const latestStrongAt = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
  return latestStrongAt <= record.dismissedAt
}

function pickRepresentativeTab(tabs: DashboardTab[], currentWindowId: number | null): DashboardTab | null {
  return tabs.toSorted((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    const aCurrentWindow = currentWindowId != null && a.windowId === currentWindowId
    const bCurrentWindow = currentWindowId != null && b.windowId === currentWindowId
    if (aCurrentWindow !== bCurrentWindow) return aCurrentWindow ? -1 : 1
    return Number(a.id || 0) - Number(b.id || 0)
  })[0] || null
}

function scoreWorkingSetRecord(record: WorkingSetActivityRecord, now: number, domainEvents: number): number {
  const lastStrongAt = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
  if (!lastStrongAt) return 0

  const recency = 10_000 * Math.exp(-Math.max(0, now - lastStrongAt) / (4 * 60 * 60 * 1000))
  const today = weightedEventCount(record.events, now, SAME_DAY_MS, 50, 60)
  const week = weightedEventCount(record.events, now, CURRENT_WEEK_MS, 8, 10)
  const domainHabit = Math.min(domainEvents, 20) * 2
  return recency + today + week + domainHabit
}

function weightedEventCount(events: WorkingSetActivityEvent[], now: number, windowMs: number, activationWeight: number, navigationWeight: number): number {
  return events
    .filter((event) => now - event.at <= windowMs)
    .reduce((score, event) => score + (event.kind === 'activation' ? activationWeight : navigationWeight), 0)
}

function recentEventCount(events: WorkingSetActivityEvent[], now: number, windowMs: number): number {
  return events.filter((event) => now - event.at <= windowMs).length
}

function latestEventAt(events: WorkingSetActivityEvent[], kind: WorkingSetActivityKind): number | undefined {
  const latest = events.filter((event) => event.kind === kind).reduce((max, event) => Math.max(max, event.at), 0)
  return latest || undefined
}

function domainForPageIdentity(key: string): string {
  return URL.parse(key)?.hostname || ''
}

function displayUrlForPageIdentity(key: string): string {
  const parsed = URL.parse(key)
  if (!parsed) return key
  if (parsed.protocol === 'file:') return parsed.pathname
  return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
}
