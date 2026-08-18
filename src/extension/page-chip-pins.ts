/* ================================================================
   Page chip pins

   Page-chip pins are explicit user ordering state scoped to one
   rendered sibling list. They are separate from section pins and from
   Chrome's native tab.pinned flag.
   ================================================================ */

export const PAGE_CHIP_PIN_STORAGE_KEY = 'tabOutPinnedPageChipsV1'

export type PinnedPageChipMutation = {
  type: 'set-pinned'
  id: string
  pinned: boolean
}

const PAGE_CHIP_PIN_KIND = 'page-chip'
const PAGE_CHIP_PIN_FIELD_COUNT = 3
const VALID_PAGE_CHIP_PIN_SOURCES = new Set(['tabs', 'bookmarks', 'history'])

export type PinnedPageChipIndex = ReadonlyMap<string, ReadonlyMap<string, number>>

type ParsedPageChipPinId = {
  source: string
  scopeId: string
  chipKey: string
}

function encodePinField(value: string): string {
  return encodeURIComponent(value)
}

function decodePinField(value: string): string {
  return decodeURIComponent(value)
}

function pageChipPinScopeIndexKey(source: string, scopeId: string): string {
  return `${source}\u0000${scopeId}`
}

export function pageChipPinScopeId(
  domain: string,
  subdomainKey: string,
  websitePathKey: string,
  pathgroupKey: string,
): string {
  return ['scope', domain, subdomainKey, websitePathKey, pathgroupKey].join('|')
}

export function pageChipPinKeyForUrl(url: string): string {
  return `url:${url}`
}

export function pageChipFoldRepresentativeUrl(urls: readonly string[]): string {
  let representative: string | null = null
  for (const url of urls) {
    if (representative === null || url < representative) representative = url
  }
  return representative ?? ''
}

export function pageChipPinKeyForFoldUrls(urls: readonly string[]): string {
  return `fold:${pageChipFoldRepresentativeUrl(urls)}`
}

export function pageChipPinId(source: string, scopeId: string, chipKey: string): string {
  return [PAGE_CHIP_PIN_KIND, source, scopeId, chipKey].map(encodePinField).join('|')
}

function parsePageChipPinId(id: unknown): ParsedPageChipPinId | null {
  if (typeof id !== 'string' || id === '') return null
  const parts = id.split('|')
  if (parts.length !== PAGE_CHIP_PIN_FIELD_COUNT + 1) return null
  let kind = ''
  let source = ''
  let scopeId = ''
  let chipKey = ''
  try {
    const decoded = parts.map(decodePinField)
    kind = decoded[0] ?? ''
    source = decoded[1] ?? ''
    scopeId = decoded[2] ?? ''
    chipKey = decoded[3] ?? ''
  } catch {
    return null
  }
  if (kind !== PAGE_CHIP_PIN_KIND) return null
  if (!VALID_PAGE_CHIP_PIN_SOURCES.has(source)) return null
  if (!scopeId.startsWith('scope|')) return null
  if (!(chipKey.startsWith('url:') || chipKey.startsWith('fold:'))) return null
  if (chipKey.startsWith('fold:')) {
    chipKey = pageChipPinKeyForFoldUrls(chipKey.slice('fold:'.length).split('\u0000'))
  }
  return { source, scopeId, chipKey }
}

function normalizedPageChipPinId(id: unknown): string | null {
  const parsed = parsePageChipPinId(id)
  return parsed
    ? pageChipPinId(parsed.source, parsed.scopeId, parsed.chipKey)
    : null
}

function forEachNormalizedPageChipPin(
  ids: unknown,
  visit: (id: string, parsed: ParsedPageChipPinId, order: number) => void,
): void {
  const seen = new Set<string>()
  let order = 0
  for (const id of Array.isArray(ids) ? ids : []) {
    const parsed = parsePageChipPinId(id)
    if (!parsed) continue
    const normalizedId = pageChipPinId(parsed.source, parsed.scopeId, parsed.chipKey)
    if (seen.has(normalizedId)) continue
    seen.add(normalizedId)
    visit(normalizedId, parsed, order)
    order += 1
  }
}

export function normalizePinnedPageChips(ids: unknown = []): string[] {
  const normalized: string[] = []
  forEachNormalizedPageChipPin(ids, (id) => normalized.push(id))
  return normalized
}

function setPinnedPageChipInList(ids: unknown = [], id: unknown, pinned: boolean): string[] {
  const normalized = normalizePinnedPageChips(ids)
  const normalizedId = normalizedPageChipPinId(id)
  if (!normalizedId) return normalized
  const isPinned = normalized.includes(normalizedId)
  if (isPinned === pinned) return normalized
  return pinned
    ? [...normalized, normalizedId]
    : normalized.filter((existing) => existing !== normalizedId)
}

export function applyPinnedPageChipMutation(ids: unknown, mutation: PinnedPageChipMutation): string[] {
  return setPinnedPageChipInList(ids, mutation.id, mutation.pinned)
}

export function createPinnedPageChipIndex(ids: unknown = []): PinnedPageChipIndex {
  const index = new Map<string, Map<string, number>>()
  forEachNormalizedPageChipPin(ids, (_id, parsed, order) => {
    const scopeKey = pageChipPinScopeIndexKey(parsed.source, parsed.scopeId)
    const scopeIndex = index.getOrInsertComputed(scopeKey, () => new Map())
    scopeIndex.getOrInsert(parsed.chipKey, order)
  })
  return index
}

export function pinnedPageChipOrder(
  index: PinnedPageChipIndex | null | undefined,
  source: string,
  scopeId: string,
  chipKey: string,
): number | null {
  const order = index?.get(pageChipPinScopeIndexKey(source, scopeId))?.get(chipKey)
  return typeof order === 'number' ? order : null
}
