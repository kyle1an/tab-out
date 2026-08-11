/* ================================================================
   Section pins

   Per-card section ordering: a pinned subdomain section, website-path
   section, or pathgroup cluster floats to the top of its parent within
   the domain card. Persists to chrome.storage.local. Mirrors the
   tabOutPinnedDomainsV1 pattern in domain-pins.ts.
   ================================================================ */

export const SECTION_PIN_STORAGE_KEY = 'tabOutPinnedSectionsV1'

export type PinnedSectionMutation = {
  type: 'set-pinned'
  id: string
  pinned: boolean
}

const PIN_KIND_SUBDOMAIN = 'subdomain'
const PIN_KIND_WEBSITE_PATH = 'website-path'
const PIN_KIND_PATHGROUP = 'pathgroup'
const PIN_KIND_V2_SUFFIX = ':v2'

// Identity layout per kind. Field counts are fixed (including for empty
// slots) so that two ids with the same labels but different parents
// never collide.
const PIN_KIND_FIELD_COUNTS: Record<string, number> = {
  [PIN_KIND_SUBDOMAIN]: 2,
  [`${PIN_KIND_SUBDOMAIN}${PIN_KIND_V2_SUFFIX}`]: 2,
  [PIN_KIND_WEBSITE_PATH]: 3,
  [`${PIN_KIND_WEBSITE_PATH}${PIN_KIND_V2_SUFFIX}`]: 3,
  [PIN_KIND_PATHGROUP]: 4,
  [`${PIN_KIND_PATHGROUP}${PIN_KIND_V2_SUFFIX}`]: 4,
}

function encodePinField(field: string): string {
  // Keep every legacy delimiter-safe id byte-for-byte stable while escaping
  // the delimiter for arbitrary URL-derived section keys.
  return field.replaceAll('%', '%25').replaceAll('|', '%7C')
}

function buildPinId(kind: string, fields: string[]): string {
  // Preserve every legacy id when its fields are delimiter-safe, including
  // existing URL escapes such as `%20`. Only unsafe identities enter a
  // versioned namespace where escaping `%` cannot collide with legacy text.
  if (!fields.some((field) => field.includes('|'))) return [kind, ...fields].join('|')
  return [`${kind}${PIN_KIND_V2_SUFFIX}`, ...fields.map(encodePinField)].join('|')
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
  pathgroupKey: string,
): string {
  return buildPinId(PIN_KIND_PATHGROUP, [domain, subdomainKey, websitePathKey, pathgroupKey])
}

function isPinnableSectionId(id: unknown): id is string {
  if (typeof id !== 'string' || id === '') return false
  const parts = id.split('|')
  const kind = parts[0]
  if (!kind) return false
  const expected = PIN_KIND_FIELD_COUNTS[kind]
  return typeof expected === 'number' && parts.length === expected + 1
}

export function normalizePinnedSections(ids: unknown = []): string[] {
  return [...new Set(
    (Array.isArray(ids) ? ids : []).filter(isPinnableSectionId),
  )]
}

function setPinnedSectionInList(ids: unknown = [], id: unknown, pinned: boolean): string[] {
  const normalized = normalizePinnedSections(ids)
  if (!isPinnableSectionId(id)) return normalized
  const isPinned = normalized.includes(id)
  if (isPinned === pinned) return normalized
  return pinned ? [...normalized, id] : normalized.filter((existing) => existing !== id)
}

export function applyPinnedSectionMutation(ids: unknown, mutation: PinnedSectionMutation): string[] {
  return setPinnedSectionInList(ids, mutation.id, mutation.pinned)
}
