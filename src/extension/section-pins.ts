/* ================================================================
   Section pins

   Per-card section ordering: a pinned subdomain section, website-path
   section, or pathgroup cluster floats to the top of its parent within
   the domain card. Persists to chrome.storage.local. Mirrors the
   tabOutPinnedDomainsV1 pattern in domain-pins.ts.
   ================================================================ */

export const SECTION_PIN_STORAGE_KEY = 'tabOutPinnedSectionsV1'

const PIN_KIND_SUBDOMAIN = 'subdomain'
const PIN_KIND_WEBSITE_PATH = 'website-path'
const PIN_KIND_PATHGROUP = 'pathgroup'

// Identity layout per kind. Field counts are fixed (including for empty
// slots) so that two ids with the same labels but different parents
// never collide.
const PIN_KIND_FIELD_COUNTS: Record<string, number> = {
  [PIN_KIND_SUBDOMAIN]: 2,
  [PIN_KIND_WEBSITE_PATH]: 3,
  [PIN_KIND_PATHGROUP]: 4
}

function buildPinId(kind: string, fields: string[]): string {
  return [kind, ...fields].join('|')
}

export function subdomainPinId(domain: string, subdomainKey: string): string {
  return buildPinId(PIN_KIND_SUBDOMAIN, [domain, subdomainKey])
}

export function websitePathPinId(domain: string, subdomainKey: string, websitePathKey: string): string {
  return buildPinId(PIN_KIND_WEBSITE_PATH, [domain, subdomainKey, websitePathKey])
}

export function pathgroupPinId(
  domain: string,
  subdomainKey: string,
  websitePathKey: string,
  pathgroupKey: string
): string {
  return buildPinId(PIN_KIND_PATHGROUP, [domain, subdomainKey, websitePathKey, pathgroupKey])
}

export function isPinnableSectionId(id: unknown): id is string {
  if (typeof id !== 'string' || id === '') return false
  const parts = id.split('|')
  const expected = PIN_KIND_FIELD_COUNTS[parts[0]]
  return typeof expected === 'number' && parts.length === expected + 1
}

export function normalizePinnedSections(ids: unknown = []): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const id of ids) {
    if (!isPinnableSectionId(id) || seen.has(id)) continue
    seen.add(id)
    normalized.push(id)
  }
  return normalized
}

export function togglePinnedSectionInList(ids: unknown = [], id: unknown): string[] {
  const normalized = normalizePinnedSections(ids)
  if (!isPinnableSectionId(id)) return normalized
  return normalized.includes(id) ? normalized.filter((existing) => existing !== id) : [...normalized, id]
}

export async function loadPinnedSections(): Promise<string[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  try {
    const stored = await chrome.storage.local.get(SECTION_PIN_STORAGE_KEY)
    return normalizePinnedSections(stored[SECTION_PIN_STORAGE_KEY])
  } catch {
    return []
  }
}

export async function savePinnedSections(ids: unknown = []): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set({
    [SECTION_PIN_STORAGE_KEY]: normalizePinnedSections(ids)
  })
}
