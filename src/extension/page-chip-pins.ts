/* ================================================================
   Page chip pins

   Page-chip pins are explicit user ordering state scoped to one
   rendered sibling list. They are separate from section pins and from
   Chrome's native tab.pinned flag.
   ================================================================ */

export const PAGE_CHIP_PIN_STORAGE_KEY = 'tabOutPinnedPageChipsV1'

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
  pathgroupKey: string
): string {
  return ['scope', domain, subdomainKey, websitePathKey, pathgroupKey].join('|')
}

export function pageChipPinKeyForUrl(url: string): string {
  return `url:${url}`
}

export function pageChipPinKeyForFoldUrls(urls: readonly string[]): string {
  return `fold:${urls.slice().sort().join('\u0000')}`
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
    ;[kind, source, scopeId, chipKey] = parts.map(decodePinField)
  } catch {
    return null
  }
  if (kind !== PAGE_CHIP_PIN_KIND) return null
  if (!VALID_PAGE_CHIP_PIN_SOURCES.has(source)) return null
  if (!scopeId.startsWith('scope|')) return null
  if (!(chipKey.startsWith('url:') || chipKey.startsWith('fold:'))) return null
  return { source, scopeId, chipKey }
}

function isPinnablePageChipId(id: unknown): id is string {
  return parsePageChipPinId(id) !== null
}

export function normalizePinnedPageChips(ids: unknown = []): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const id of ids) {
    if (!isPinnablePageChipId(id) || seen.has(id)) continue
    seen.add(id)
    normalized.push(id)
  }
  return normalized
}

export function togglePinnedPageChipInList(ids: unknown = [], id: unknown): string[] {
  const normalized = normalizePinnedPageChips(ids)
  if (!isPinnablePageChipId(id)) return normalized
  return normalized.includes(id) ? normalized.filter((existing) => existing !== id) : [...normalized, id]
}

export function createPinnedPageChipIndex(ids: unknown = []): PinnedPageChipIndex {
  const index = new Map<string, Map<string, number>>()
  normalizePinnedPageChips(ids).forEach((id, order) => {
    const parsed = parsePageChipPinId(id)
    if (!parsed) return
    const scopeKey = pageChipPinScopeIndexKey(parsed.source, parsed.scopeId)
    const scopeIndex = index.get(scopeKey) || new Map<string, number>()
    if (!scopeIndex.has(parsed.chipKey)) scopeIndex.set(parsed.chipKey, order)
    index.set(scopeKey, scopeIndex)
  })
  return index
}

export function pinnedPageChipOrder(
  index: PinnedPageChipIndex | null | undefined,
  source: string,
  scopeId: string,
  chipKey: string
): number | null {
  const order = index?.get(pageChipPinScopeIndexKey(source, scopeId))?.get(chipKey)
  return typeof order === 'number' ? order : null
}

export async function loadPinnedPageChips(): Promise<string[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  try {
    const stored = await chrome.storage.local.get(PAGE_CHIP_PIN_STORAGE_KEY)
    return normalizePinnedPageChips(stored[PAGE_CHIP_PIN_STORAGE_KEY])
  } catch {
    return []
  }
}

export async function savePinnedPageChips(ids: unknown = []): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set({
    [PAGE_CHIP_PIN_STORAGE_KEY]: normalizePinnedPageChips(ids)
  })
}
