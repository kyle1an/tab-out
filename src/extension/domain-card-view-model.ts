import { domainGroupCardId } from './domain-card-id.js'
import { pickFavicon } from './favicons.js'
import { isGroupedTab, groupDotColor } from './groups.js'
import { cleanTitleWithRemovedSuffix, stripTitleNoise } from './titles.js'
import { subdomainPrefix } from './domains.js'
import { resolvePathGroup } from './path-groups.js'
import { resolveGenericWebsitePathSection, resolveWebsitePathSection } from './website-path-sections.js'
import { tabMatchesSourceFilter } from './filter-match.js'
import { countClosableDuplicateExtras } from './tab-dedupe-policy.js'
import { dashboardItemNameForTabs } from './dashboard-source.js'
import type { DashboardCardVM, DashboardChipData, DashboardClusterVM, DashboardSectionVM, DashboardSegment, DashboardTab, DashboardTitleSuppression, DashboardWebsitePathSectionVM, DomainGroup, PathGroupResult, WebsitePathSectionResult } from './types'

type CardMode = 'matched' | 'unmatched'
type ComputeCardOptions = {
  filter?: string
  mode?: CardMode
  allowMutations?: boolean
  currentWindowId?: number | null
}
type PathCategory = NonNullable<PathGroupResult['category']>
type TitlePresentation = {
  displayTitle: string
  suppressedTitleParts: string[]
  suppressedTitlePartPositions: number[]
  suppressedTitlePartsBeforeStructuralTail: string[]
}
type BaseTitlePresentation = {
  displayTitle: string
  removedDomainTitleSuffix: string
}
type StructuralTitleTail = {
  label: string
  includeSeparatorInSuppression: boolean
}
type TitleSuppressionCandidate = {
  index: number
  text: string
  structuralTailIndex: number | null
}
type TitlePresentationRow = {
  url: string
  rawTitle: string
  displayTitle: string
  removedDomainTitleSuffix: string
  removedDomainTitleSuffixLabel: string
  suppressedTitleParts: string[]
  suppressedTitlePartPositions: number[]
  suppressedTitlePartsBeforeStructuralTail: string[]
  structuralTails: StructuralTitleTail[]
  pathGroupKey: string
}
type SectionContentVM = {
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  clusters: DashboardClusterVM[]
}
type WebsitePathSectionBucket = WebsitePathSectionResult & {
  tabs: DashboardTab[]
}
type ChipBuildEntry = {
  tab: DashboardTab
  chip: DashboardChipData
  titleKey: string
}

const TITLE_SEGMENT_SEPARATORS = [' - ', ' | ', ' — ', ' · ', ' – ']
const TITLE_STRUCTURAL_PLACEHOLDER_SEPARATORS = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
const TITLE_BOUNDARY_SEPARATOR_RE = /^[-\u2013\u2014\u00b7|:]/
const TITLE_BOUNDARY_TRAILING_SEPARATOR_RE = /[-\u2013\u2014\u00b7|:]$/

function pickDashboardChipFavicon(tab: DashboardTab): string {
  if ((tab.sourceType || 'tab') === 'tab') return tab.favIconUrl || ''
  return pickFavicon(tab)
}

/**
 * injectBreakPoints(str) — insert U+200B (zero-width space) into
 * long unbreakable tokens so the browser can wrap them without us
 * setting `word-break: break-all`. ZWSP is a Unicode break
 * opportunity that renders as nothing — no hyphen, no visible glyph,
 * just an invisible break point.
 *
 * Threshold: tokens of 15+ letters/digits/underscore get a ZWSP
 * inserted every 5 chars. Below that threshold, words pass through
 * untouched so natural-length English wraps at word boundaries and
 * short words never break mid-character.
 */
/**
 * @param {string} str
 * @returns {string}
 */
function injectBreakPoints(str: string): string {
  if (!str) return str
  return str.replace(/[A-Za-z0-9_]{15,}/g, (token) => token.replace(/(.{5})(?=.)/g, '$1\u200B'))
}

function trailingTitleSegment(title: string): { index: number; separator: string; suffix: string } | null {
  let match: { index: number; separator: string; suffix: string } | null = null
  for (const separator of TITLE_SEGMENT_SEPARATORS) {
    const index = title.lastIndexOf(separator)
    if (index === -1 || index < (match?.index ?? -1)) continue
    match = { index, separator, suffix: title.slice(index + separator.length).trim() }
  }
  return match?.suffix ? match : null
}

function isSuppressibleTrailingTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (text.length < 4 || /[\d/#?&=]/.test(text)) return false
  const words = text.split(/\s+/).filter(Boolean)
  return words.length >= 2 || /^[A-Z]{2,}$/.test(text)
}

function isSuppressiblePathGroupTrailingTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (isSuppressibleTrailingTitleSegment(text)) return true
  if (text.length < 4 || /[\d/#?&=]/.test(text) || !/[A-Za-z]/.test(text)) return false
  return /[-_]/.test(text)
}

function isExpandableStructuralTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (text.length < 4 || /[\d/#?&=]/.test(text)) return false
  return text.split(/\s+/).filter(Boolean).length === 1
}

function matchingStructuralTrailingTitleSegment(title: string, structuralTails: StructuralTitleTail[]) {
  const tailsByKey = new Map(
    structuralTails
      .map((tail) => [tail.label.trim().toLowerCase(), tail] as const)
      .filter(([key]) => key)
  )
  if (tailsByKey.size === 0) return null
  const segment = trailingTitleSegment(title)
  if (!segment) return null
  const suffixKey = segment.suffix.trim().toLowerCase()
  const tail = tailsByKey.get(suffixKey)
  return tail ? { ...segment, includeSeparatorInSuppression: tail.includeSeparatorInSuppression } : null
}

function titleSuppressionCandidates(
  title: string,
  structuralTails: StructuralTitleTail[] = [],
  isSuppressibleSegment = isSuppressibleTrailingTitleSegment
): TitleSuppressionCandidate[] {
  const structuralTail = matchingStructuralTrailingTitleSegment(title, structuralTails)
  const scopeTitle = structuralTail ? title.slice(0, structuralTail.index).trim() : title
  const segment = trailingTitleSegment(scopeTitle)
  if (!segment) return []

  const candidates: TitleSuppressionCandidate[] = []
  const suffix = scopeTitle.slice(segment.index + segment.separator.length).trim()
  if (isSuppressibleSegment(suffix)) {
    candidates.push({
      index: segment.index,
      text: title.slice(segment.index, structuralTail ? structuralTail.index + (structuralTail.includeSeparatorInSuppression ? structuralTail.separator.length : 0) : undefined).trim(),
      structuralTailIndex: structuralTail?.index ?? null
    })
  }

  if (structuralTail) {
    const prefix = scopeTitle.slice(0, segment.index).trim()
    const previousSegment = trailingTitleSegment(prefix)
    if (previousSegment && isExpandableStructuralTitleSegment(previousSegment.suffix)) {
      const expandedSuffix = scopeTitle.slice(previousSegment.index + previousSegment.separator.length).trim()
      if (isSuppressibleSegment(expandedSuffix)) {
        candidates.push({
          index: previousSegment.index,
          text: title.slice(previousSegment.index, structuralTail.index + (structuralTail.includeSeparatorInSuppression ? structuralTail.separator.length : 0)).trim(),
          structuralTailIndex: structuralTail.index
        })
      }
    }
  }

  return candidates
}

function uniqueTitleSuppressionCandidates(candidates: TitleSuppressionCandidate[]): TitleSuppressionCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.index}\u0000${candidate.structuralTailIndex ?? ''}\u0000${candidate.text.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isActiveInOtherWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active) return false
  if (tab.isApp) return false
  if (typeof currentWindowId !== 'number') return true
  return tab.windowId !== currentWindowId
}

function isCurrentTabOutPage(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || !tab.isTabOut || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

function isActiveInCurrentWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

function activeFrameStateForDuplicateSet(tabs: readonly DashboardTab[], currentWindowId: number | null): Pick<DashboardChipData, 'activeInOtherWindow' | 'activeChipFrame'> {
  const activeInOtherWindow = tabs.some((tab) => isActiveInOtherWindow(tab, currentWindowId))
  const activeCurrentWindowDuplicate = tabs.length > 1 && tabs.some((tab) => isActiveInCurrentWindow(tab, currentWindowId))
  const activeCurrentTabOutPage = tabs.some((tab) => isCurrentTabOutPage(tab, currentWindowId))

  return {
    activeInOtherWindow,
    activeChipFrame: activeInOtherWindow || activeCurrentWindowDuplicate || activeCurrentTabOutPage
  }
}

/**
 * stripPgLabel(label, pgLabel) — build the chip title as a segment
 * array where EVERY occurrence of the pill label (as an exact
 * literal, nothing absorbed on either side) is replaced in place
 * by a placeholder object. Whatever characters follow the match
 * — a "@sha" commit hash, a "/tree/main" subpath, plain text —
 * are kept verbatim; only the label itself becomes the placeholder.
 * The char BEFORE the match must be a boundary (start of string or
 * a separator) so "label" inside "prelabel" isn't falsely matched.
 *
 *   prefix:   "owner/repo PR #4706"                   → [PH, " PR #4706"]
 *   suffix:   "Pull Request #4706 · owner/repo"       → ["Pull Request #4706 · ", PH]
 *   middle:   "PR #4706 · owner/repo · GitHub"        → ["PR #4706", " · ", PH, " · GitHub"]
 *   ref tail: "Size preview · owner/repo@296a5f1"     → ["Size preview", " · ", PH, "@296a5f1"]
 *   multi:    "owner/repo · log · owner/repo · PR"    → [PH, " · log", " · ", PH, " · PR"]
 *
 * When no boundary-preceded occurrence is found, or when stripping
 * would leave only separators + placeholders (e.g. the title is just
 * the label, or label-sep-label with nothing else), the original
 * label is returned as a single-segment array.
 */
function stripPgLabel(label: string, pgLabel: string): DashboardSegment[] {
  if (!pgLabel || !label || label === pgLabel) {
    return [label]
  }
  const seps = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const EL = esc(pgLabel)
  const SEP = '(?:' + seps.map(esc).join('|') + ')'
  const re = new RegExp(`(^|${SEP})(${EL})`, 'g')

  const hits: Array<{ index: number; length: number; prefixSep: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(label)) !== null) {
    hits.push({ index: m.index, length: m[0].length, prefixSep: m[1] })
    if (m.index === re.lastIndex) re.lastIndex++
  }
  if (hits.length === 0) return [label]

  const segments: DashboardSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    const textBefore = label.slice(cursor, hit.index)
    if (textBefore) segments.push(textBefore)
    if (hit.prefixSep) segments.push(hit.prefixSep)
    segments.push({ placeholder: true, label: pgLabel })
    cursor = hit.index + hit.length
  }
  const textAfter = label.slice(cursor)
  if (textAfter) segments.push(textAfter)

  const hasText = segments.some((s) => typeof s === 'string' && s.trim())
  if (!hasText) return [label]

  return segments
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true } {
  return typeof segment !== 'string' && 'placeholder' in segment
}

function isBoundaryWrappedTitleSuppression(part: string): boolean {
  const text = part.trim()
  return TITLE_BOUNDARY_SEPARATOR_RE.test(text) && TITLE_BOUNDARY_TRAILING_SEPARATOR_RE.test(text)
}

function titleSuppressionPartPosition(title: string, part: string): number {
  const index = title.toLowerCase().indexOf(part.toLowerCase())
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

function titleSuppressionTailLabel(part: string): string {
  return part.trim().replace(TITLE_BOUNDARY_SEPARATOR_RE, '').trim()
}

function insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
  segments: DashboardSegment[],
  suppressedTitleParts: string[]
): DashboardSegment[] {
  if (suppressedTitleParts.length === 0) return segments

  const placeholderIndex = segments.findLastIndex(isStructuralPlaceholderSegment)
  if (placeholderIndex <= 0) return segments

  const separator = segments[placeholderIndex - 1]
  if (typeof separator !== 'string' || !TITLE_STRUCTURAL_PLACEHOLDER_SEPARATORS.includes(separator)) {
    return segments
  }

  const inserted: DashboardSegment[] = []
  const suppressionsIncludeBoundary = suppressedTitleParts.some(isBoundaryWrappedTitleSuppression)
  for (const part of suppressedTitleParts) {
    inserted.push({ titleSuppression: part }, suppressionsIncludeBoundary ? ' ' : separator)
  }

  if (suppressionsIncludeBoundary) {
    return [
      ...segments.slice(0, placeholderIndex - 1),
      ' ',
      ...inserted,
      ...segments.slice(placeholderIndex)
    ]
  }

  return [
    ...segments.slice(0, placeholderIndex),
    ...inserted,
    ...segments.slice(placeholderIndex)
  ]
}

function rowHasSuppressionSequence(parts: string[], sequence: string[]): boolean {
  for (let index = 0; index <= parts.length - sequence.length; index += 1) {
    if (sequence.every((part, offset) => parts[index + offset] === part)) return true
  }
  return false
}

function continuousSuppressionSpan(title: string, parts: string[]): string | null {
  if (parts.length < 2) return null

  const lowerTitle = title.toLowerCase()
  const firstPart = parts[0].toLowerCase()
  let searchStart = 0

  while (searchStart < lowerTitle.length) {
    const startIndex = lowerTitle.indexOf(firstPart, searchStart)
    if (startIndex === -1) return null

    let cursor = startIndex + parts[0].length
    let matched = true
    for (const part of parts.slice(1)) {
      const partIndex = lowerTitle.indexOf(part.toLowerCase(), cursor)
      if (partIndex === -1 || title.slice(cursor, partIndex).trim()) {
        matched = false
        break
      }
      cursor = partIndex + part.length
    }

    if (matched) return title.slice(startIndex, cursor).trim()
    searchStart = startIndex + 1
  }

  return null
}

function mergeContinuousSuppressedTitleParts(rows: TitlePresentationRow[]) {
  const rowIndexesByPart = new Map<string, number[]>()
  rows.forEach((row, rowIndex) => {
    for (const part of row.suppressedTitleParts) {
      if (!rowIndexesByPart.has(part)) rowIndexesByPart.set(part, [])
      const indexes = rowIndexesByPart.get(part)
      if (indexes?.[indexes.length - 1] !== rowIndex) indexes?.push(rowIndex)
    }
  })

  const occurrenceKeyByPart = new Map<string, string>()
  for (const [part, rowIndexes] of rowIndexesByPart) {
    occurrenceKeyByPart.set(part, rowIndexes.join('\u0000'))
  }

  const mergeTextBySequence = new Map<string, string | null>()
  function mergeTextFor(sequence: string[]): string | null {
    const sequenceKey = sequence.join('\u0001')
    if (mergeTextBySequence.has(sequenceKey)) return mergeTextBySequence.get(sequenceKey) ?? null

    const occurrenceKey = occurrenceKeyByPart.get(sequence[0])
    if (!occurrenceKey || !sequence.every((part) => occurrenceKeyByPart.get(part) === occurrenceKey)) {
      mergeTextBySequence.set(sequenceKey, null)
      return null
    }

    const rowIndexes = rowIndexesByPart.get(sequence[0]) || []
    let mergedText = ''
    for (const rowIndex of rowIndexes) {
      const row = rows[rowIndex]
      if (!rowHasSuppressionSequence(row.suppressedTitleParts, sequence)) {
        mergeTextBySequence.set(sequenceKey, null)
        return null
      }
      const span = continuousSuppressionSpan(row.rawTitle, sequence)
      if (!span || (mergedText && span !== mergedText)) {
        mergeTextBySequence.set(sequenceKey, null)
        return null
      }
      mergedText = span
    }

    mergeTextBySequence.set(sequenceKey, mergedText || null)
    return mergedText || null
  }

  for (const row of rows) {
    if (row.suppressedTitleParts.length < 2) continue

    const partsBeforeStructuralTail = new Set(row.suppressedTitlePartsBeforeStructuralTail)
    const nextParts: string[] = []
    const nextPartPositions: number[] = []
    const nextPartsBeforeStructuralTail: string[] = []
    for (let index = 0; index < row.suppressedTitleParts.length;) {
      let merged: { text: string; endIndex: number } | null = null
      for (let endIndex = row.suppressedTitleParts.length; endIndex > index + 1; endIndex -= 1) {
        const sequence = row.suppressedTitleParts.slice(index, endIndex)
        const text = mergeTextFor(sequence)
        if (text) {
          merged = { text, endIndex }
          break
        }
      }

      if (merged) {
        const sequence = row.suppressedTitleParts.slice(index, merged.endIndex)
        nextParts.push(merged.text)
        nextPartPositions.push(titleSuppressionPartPosition(row.rawTitle, merged.text))
        if (sequence.every((part) => partsBeforeStructuralTail.has(part))) {
          nextPartsBeforeStructuralTail.push(merged.text)
        }
        index = merged.endIndex
        continue
      }

      const part = row.suppressedTitleParts[index]
      nextParts.push(part)
      nextPartPositions.push(row.suppressedTitlePartPositions[index] ?? titleSuppressionPartPosition(row.rawTitle, part))
      if (partsBeforeStructuralTail.has(part)) nextPartsBeforeStructuralTail.push(part)
      index += 1
    }

    row.suppressedTitleParts = nextParts
    row.suppressedTitlePartPositions = nextPartPositions
    row.suppressedTitlePartsBeforeStructuralTail = nextPartsBeforeStructuralTail
  }
}

/**
 * disambiguatingPaths(urls) — given a list of URLs that share a
 * visible title, return just the *differing* tokens for each. Path
 * segments, query string, and hash are all treated as tokens in a
 * single list, so differences in any of them can disambiguate. The
 * longest common leading AND trailing tokens are stripped; only
 * what differs is shown.
 *
 *   ["/api/v1/accounts/team/dashboard",
 *    "/api/v1/accounts/me/dashboard"]      → ["…/team", "…/me"]
 *   ["/admin/dashboard", "/user/dashboard"] → ["/admin", "/user"]
 *   ["/dashboard", "/admin/dashboard"]      → ["/", "/admin"]
 *   ["/rewards?state=open",
 *    "/rewards?state=closed"]               → ["…?state=open", "…?state=closed"]
 *   ["/doc#intro", "/doc#conclusion"]       → ["…#intro", "…#conclusion"]
 */
/**
 * @param {string[]} urls
 * @returns {string[]}
 */
function disambiguatingPaths(urls: string[]): string[] {
  const tokens = urls.map((u) => {
    try {
      const parsed = new URL(u)
      const t = parsed.pathname.split('/').filter(Boolean)
      if (parsed.search) t.push(parsed.search) // "?foo=bar"
      if (parsed.hash) t.push(parsed.hash) // "#section"
      return t
    } catch {
      return []
    }
  })
  const minLen = Math.min(...tokens.map((t) => t.length))

  let commonLead = 0
  for (let i = 0; i < minLen; i++) {
    const seg = tokens[0][i]
    if (tokens.every((t) => t[i] === seg)) commonLead = i + 1
    else break
  }

  let commonTrail = 0
  const maxTrail = minLen - commonLead
  for (let i = 1; i <= maxTrail; i++) {
    const seg = tokens[0][tokens[0].length - i]
    if (tokens.every((t) => t[t.length - i] === seg)) commonTrail = i
    else break
  }

  return tokens.map((t) => {
    const show = t.slice(commonLead, t.length - commonTrail)
    if (show.length === 0) return '/'
    // Path segments join with '/'; query/hash attach without a slash
    // (their leading sigil '?' or '#' is already a delimiter).
    let joined = ''
    for (const seg of show) {
      if (seg.startsWith('?') || seg.startsWith('#')) joined += seg
      else joined += (joined ? '/' : '') + seg
    }
    const first = show[0] || ''
    const firstIsPath = !first.startsWith('?') && !first.startsWith('#')
    const lead = commonLead > 0 ? '…' : ''
    return lead + (firstIsPath ? '/' : '') + joined
  })
}

/* ---- Domain card view-model ----
   Builds the per-card data consumed by <DomainCard>. Filtering used
   to be done imperatively in filter.js — walk each chip's DOM,
   toggle style.display, update each section-count, recompute the
   close-domain / dedup labels from per-card state. The whole thing
   is now inside this function: pass `{ filter, mode }` and get back
   a VM whose visibleChips / sections / closableCount already reflect
   the current filter scope.

     • filter — normalized (trim + lowercase) query string ('' means
                no filter)
     • mode   — 'matched' (keep tabs that match the filter) or
                'unmatched' (keep tabs that DON'T match; used for the
                secondary "Other tabs" grid). Empty filter in
                'unmatched' yields an all-hidden card — nothing can
                not-match an empty query.

   Returned fields:
     • isHidden     — true when the card has zero chips under the
                      current filter; <Missions> skips it entirely
     • displayMode  — 'normal' | 'unmatched'; <DomainCard> applies
                      the card-unmatched class + suppresses bulk-
                      close buttons when 'unmatched'
     • filtering    — convenience flag; sections/chips use it to
                      bypass the "+N more" overflow split so every
                      matching chip is visible at once
*/
/**
 * @param {DomainGroup} group
 * @param {{ filter?: string, mode?: 'matched' | 'unmatched', allowMutations?: boolean, currentWindowId?: number | null }} [opts]
 * @returns {DashboardCardVM}
 */
export function computeDomainCardViewModel(group: DomainGroup, { filter = '', mode = 'matched', allowMutations = true, currentWindowId = null }: ComputeCardOptions = {}): DashboardCardVM {
  const allTabs = group.tabs || []
  const filtering = filter.trim() !== ''
  const displayMode = mode === 'unmatched' ? 'unmatched' : 'normal'
  const stableId = domainGroupCardId(group)
  const isAppsGroup = group.domain === '__standalone-apps__'

  if (filtering && isAppsGroup) {
    return { stableId, isHidden: true, displayMode, filtering }
  }

  // First thing: narrow the tab set to what this grid should show.
  // Unfiltered matched mode keeps everything; unmatched mode with an
  // empty filter keeps nothing (secondary grid is hidden upstream in
  // that case anyway, but bail early so we don't produce a ghost
  // VM full of chips).
  const tabs =
    filtering
      ? allTabs.filter((t) => {
          const m = tabMatchesSourceFilter(t, filter)
          return mode === 'unmatched' ? !m : m
        })
      : mode === 'unmatched'
        ? []
        : allTabs

  if (tabs.length === 0) {
    return { stableId, isHidden: true, displayMode, filtering }
  }

  const tabCount = tabs.length
  const totalTabCount = allTabs.length
  const itemLabel = dashboardItemNameForTabs(allTabs, 'open tab')
  const tabCountLabel = filtering && tabCount !== totalTabCount ? `${tabCount}/${totalTabCount}` : `${tabCount}`
  const tabCountTitle = filtering
    ? `${tabCount} of ${totalTabCount} ${itemLabel}${totalTabCount !== 1 ? 's' : ''} shown while filtering`
    : `${tabCount} ${itemLabel}${tabCount !== 1 ? 's' : ''}`
  const isTabOutGroup = group.domain === '__tab-out__'

  // Tabs in a Chrome group are preserved by bulk close / dedup actions.
  const closableTabs = tabs.filter((t) => !isGroupedTab(t) && !(isTabOutGroup && t.pinned))
  const closableCount = closableTabs.length

  // Count duplicates per URL and delegate the closeability rules to the
  // shared dedupe policy so dashboard counts mirror tab mutation behavior.
  const urlCounts: Record<string, number> = {}
  const tabsByUrl = new Map<string, DashboardTab[]>()
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1
    if (!tabsByUrl.has(tab.url)) tabsByUrl.set(tab.url, [])
    tabsByUrl.get(tab.url)?.push(tab)
  }

  function closableForUrl(u: string): number {
    return countClosableDuplicateExtras(tabsByUrl.get(u) || [], { isTabOutGroup })
  }
  const closableDupeUrls = [...tabsByUrl.keys()].filter((u) => closableForUrl(u) > 0)
  const closableExtras = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0)

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set<string>()
  const uniqueTabs: DashboardTab[] = []
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url)
      uniqueTabs.push(tab)
    }
  }

  function baseTitlePresentation(tab: DashboardTab): BaseTitlePresentation {
    let hostname = group.domain
    try {
      hostname = new URL(tab.url).hostname
    } catch {}
    const cleaned = cleanTitleWithRemovedSuffix(stripTitleNoise(tab.title || ''), hostname, titleNoiseSuffixesForUrl(tab.url))
    return {
      displayTitle: cleaned.title,
      removedDomainTitleSuffix: cleaned.removedSuffix
    }
  }

  function titleNoiseSuffixesForUrl(url: string): string[] {
    try {
      const parsed = new URL(url)
      if (parsed.hostname.endsWith('.atlassian.net') && parsed.pathname.startsWith('/wiki/')) return ['Confluence']
    } catch {}
    return []
  }

  function structuralPathGroup(tab: DashboardTab): PathGroupResult | null {
    try {
      return resolvePathGroup(tab.url)
    } catch {
      return null
    }
  }

  function buildTitlePresentations(): Map<string, TitlePresentation> {
    const rows: TitlePresentationRow[] = uniqueTabs.map((tab) => {
      const rawTitle = stripTitleNoise(tab.title || '')
      const baseTitle = baseTitlePresentation(tab)
      const pathGroup = structuralPathGroup(tab)
      return {
        url: tab.url,
        rawTitle,
        displayTitle: baseTitle.displayTitle,
        removedDomainTitleSuffix: baseTitle.removedDomainTitleSuffix,
        removedDomainTitleSuffixLabel: titleSuppressionTailLabel(baseTitle.removedDomainTitleSuffix),
        suppressedTitleParts: [] as string[],
        suppressedTitlePartPositions: [] as number[],
        suppressedTitlePartsBeforeStructuralTail: [] as string[],
        structuralTails: pathGroup?.label ? [{ label: pathGroup.label, includeSeparatorInSuppression: true }] : ([] as StructuralTitleTail[]),
        pathGroupKey: pathGroup?.key || ''
      }
    })

    const removedDomainTitleSuffixCounts = new Map<string, number>()
    for (const row of rows) {
      if (!row.removedDomainTitleSuffix) continue
      removedDomainTitleSuffixCounts.set(row.removedDomainTitleSuffix, (removedDomainTitleSuffixCounts.get(row.removedDomainTitleSuffix) || 0) + 1)
    }
    for (const row of rows) {
      if (!row.removedDomainTitleSuffix) continue
      if ((removedDomainTitleSuffixCounts.get(row.removedDomainTitleSuffix) || 0) > 1) {
        row.suppressedTitleParts.push(row.removedDomainTitleSuffix)
        row.suppressedTitlePartPositions.push(titleSuppressionPartPosition(row.rawTitle, row.removedDomainTitleSuffix))
      } else {
        row.displayTitle = row.rawTitle
        if (row.removedDomainTitleSuffixLabel) {
          row.structuralTails.push({
            label: row.removedDomainTitleSuffixLabel,
            includeSeparatorInSuppression: false
          })
        }
      }
    }

    if (filtering || rows.length < 2) {
      mergeContinuousSuppressedTitleParts(rows)
      return new Map(rows.map((row) => [row.url, {
        displayTitle: row.displayTitle,
        suppressedTitleParts: row.suppressedTitleParts,
        suppressedTitlePartPositions: row.suppressedTitlePartPositions,
        suppressedTitlePartsBeforeStructuralTail: row.suppressedTitlePartsBeforeStructuralTail
      }]))
    }

    const pathGroupSizes = new Map<string, number>()
    for (const row of rows) {
      if (!row.pathGroupKey) continue
      pathGroupSizes.set(row.pathGroupKey, (pathGroupSizes.get(row.pathGroupKey) || 0) + 1)
    }

    const minCount = rows.length <= 3 ? 2 : 3
    for (let pass = 0; pass < 3; pass += 1) {
      const counts = new Map<string, number>()
      const pathGroupCounts = new Map<string, Map<string, number>>()
      const candidatesByUrl = new Map<string, TitleSuppressionCandidate[]>()
      for (const row of rows) {
        const cardCandidates = titleSuppressionCandidates(row.displayTitle, row.structuralTails).filter((candidate) => row.displayTitle.slice(0, candidate.index).trim().length >= 3)
        const pathGroupCandidates = row.pathGroupKey
          ? titleSuppressionCandidates(row.displayTitle, row.structuralTails, isSuppressiblePathGroupTrailingTitleSegment)
            .filter((candidate) => row.displayTitle.slice(0, candidate.index).trim().length >= 3)
          : []
        const candidates = uniqueTitleSuppressionCandidates([...cardCandidates, ...pathGroupCandidates])
        candidatesByUrl.set(row.url, candidates)
        for (const candidate of cardCandidates) {
          const key = candidate.text.toLowerCase()
          counts.set(key, (counts.get(key) || 0) + 1)
        }
        if (row.pathGroupKey) {
          const groupCounts = pathGroupCounts.get(row.pathGroupKey) || new Map<string, number>()
          pathGroupCounts.set(row.pathGroupKey, groupCounts)
          for (const candidate of pathGroupCandidates) {
            const key = candidate.text.toLowerCase()
            groupCounts.set(key, (groupCounts.get(key) || 0) + 1)
          }
        }
      }

      const suffixesToSuppress = new Set(
        [...counts.entries()]
          .filter(([, count]) => count >= minCount && count / rows.length >= 0.25)
          .map(([suffix]) => suffix)
      )
      const pathGroupSuffixesToSuppress = new Map<string, Set<string>>()
      for (const [pathGroupKey, groupCounts] of pathGroupCounts.entries()) {
        const groupSize = pathGroupSizes.get(pathGroupKey) || 0
        if (groupSize < 2) continue
        const suffixes = new Set(
          [...groupCounts.entries()]
            .filter(([, count]) => count >= 2 && count / groupSize >= 0.75)
            .map(([suffix]) => suffix)
        )
        if (suffixes.size > 0) pathGroupSuffixesToSuppress.set(pathGroupKey, suffixes)
      }
      if (suffixesToSuppress.size === 0 && pathGroupSuffixesToSuppress.size === 0) break

      let changed = false
      for (const row of rows) {
        const pathGroupSuffixes = pathGroupSuffixesToSuppress.get(row.pathGroupKey)
        const candidate = (candidatesByUrl.get(row.url) || [])
          .filter((candidate) => {
            const key = candidate.text.toLowerCase()
            return suffixesToSuppress.has(key) || !!pathGroupSuffixes?.has(key)
          })
          .sort((a, b) => b.text.length - a.text.length)[0]
        if (!candidate) continue
        const stripped = row.displayTitle.slice(0, candidate.index).trim()
        if (stripped.length < 3) continue
        row.displayTitle = stripped + (candidate.structuralTailIndex === null ? '' : row.displayTitle.slice(candidate.structuralTailIndex))
        row.suppressedTitleParts.unshift(candidate.text)
        row.suppressedTitlePartPositions.unshift(titleSuppressionPartPosition(row.rawTitle, candidate.text))
        if (candidate.structuralTailIndex !== null) {
          row.suppressedTitlePartsBeforeStructuralTail.unshift(candidate.text)
        }
        changed = true
      }
      if (!changed) break
    }

    mergeContinuousSuppressedTitleParts(rows)
    return new Map(rows.map((row) => [row.url, {
      displayTitle: row.displayTitle,
      suppressedTitleParts: row.suppressedTitleParts,
      suppressedTitlePartPositions: row.suppressedTitlePartPositions,
      suppressedTitlePartsBeforeStructuralTail: row.suppressedTitlePartsBeforeStructuralTail
    }]))
  }

  const titlePresentationByUrl = buildTitlePresentations()

  function titlePresentation(tab: DashboardTab): TitlePresentation {
    return titlePresentationByUrl.get(tab.url) || {
      displayTitle: stripTitleNoise(tab.title || ''),
      suppressedTitleParts: [],
      suppressedTitlePartPositions: [],
      suppressedTitlePartsBeforeStructuralTail: []
    }
  }

  // Build the exact title string the chip displays BEFORE path crumbs
  // and path-group placeholders. Shared by sort order and collision
  // detection so both reason over the same visible label.
  function displayTitle(tab: DashboardTab): string {
    return titlePresentation(tab).displayTitle
  }

  function titleSuppressionSummary() {
    const partsByText = new Map<string, { text: string; count: number; firstTitlePosition: number; firstPartIndex: number; firstSeen: number }>()
    const beforeByKey = new Map<string, Set<string>>()
    let firstSeen = 0
    for (const presentation of titlePresentationByUrl.values()) {
      const partKeys = presentation.suppressedTitleParts.map(titleSuppressionKey)
      partKeys.forEach((key, index) => {
        if (!beforeByKey.has(key)) beforeByKey.set(key, new Set())
        for (const laterKey of partKeys.slice(index + 1)) beforeByKey.get(key)?.add(laterKey)
      })
      presentation.suppressedTitleParts.forEach((part, partIndex) => {
        const existing = partsByText.get(part)
        const titlePosition = presentation.suppressedTitlePartPositions[partIndex] ?? Number.MAX_SAFE_INTEGER
        if (existing) {
          existing.count += 1
          existing.firstTitlePosition = Math.min(existing.firstTitlePosition, titlePosition)
          existing.firstPartIndex = Math.min(existing.firstPartIndex, partIndex)
          return
        }
        partsByText.set(part, {
          text: part,
          count: 1,
          firstTitlePosition: titlePosition,
          firstPartIndex: partIndex,
          firstSeen
        })
        firstSeen += 1
      })
    }

    const reachesCache = new Map<string, boolean>()
    function reaches(fromKey: string, toKey: string, seen = new Set<string>()): boolean {
      const cacheKey = `${fromKey}\u0000${toKey}`
      if (reachesCache.has(cacheKey)) return !!reachesCache.get(cacheKey)
      if (seen.has(fromKey)) return false
      seen.add(fromKey)
      const direct = beforeByKey.get(fromKey)
      const result = !!direct?.has(toKey) || [...(direct ?? [])].some((nextKey) => reaches(nextKey, toKey, seen))
      reachesCache.set(cacheKey, result)
      return result
    }

    return [...partsByText.values()]
      .filter((part) => part.count > 1)
      .sort((a, b) => {
        const aKey = titleSuppressionKey(a.text)
        const bKey = titleSuppressionKey(b.text)
        const aBeforeB = reaches(aKey, bKey)
        const bBeforeA = reaches(bKey, aKey)
        if (aBeforeB && !bBeforeA) return -1
        if (bBeforeA && !aBeforeB) return 1
        return a.firstTitlePosition - b.firstTitlePosition || a.firstPartIndex - b.firstPartIndex || b.count - a.count || a.firstSeen - b.firstSeen || a.text.localeCompare(b.text, undefined, { numeric: true })
      })
      .map(({ text, count }) => ({ text, count }))
  }

  const suppressedTitleParts = titleSuppressionSummary()
  const suppressedTitlePartOrder = new Map(suppressedTitleParts.map((part, index) => [part.text.toLowerCase(), index]))
  const hasMultipleVisibleSuppressionMeanings = suppressedTitleParts.length > 1

  function titleSuppressionKey(text: string): string {
    return text.trim().toLowerCase()
  }

  function aggregateSuppressedTitleParts(tabs: DashboardTab[]): string[] {
    const partsByKey = new Map<string, { text: string; order: number; firstSeen: number }>()
    let firstSeen = 0
    for (const tab of tabs) {
      for (const part of titlePresentation(tab).suppressedTitleParts) {
        const key = part.toLowerCase()
        if (partsByKey.has(key)) continue
        partsByKey.set(key, {
          text: part,
          order: suppressedTitlePartOrder.get(key) ?? Number.MAX_SAFE_INTEGER,
          firstSeen
        })
        firstSeen += 1
      }
    }

    return [...partsByKey.values()]
      .sort((a, b) => a.order - b.order || a.firstSeen - b.firstSeen)
      .map((part) => part.text)
  }

  // Sort by title — the exact string the chip displays, so the visible
  // order never diverges from the sort order. `numeric: true` gives
  // natural number ordering (Dashboard 2 before Dashboard 11, PR #4488
  // before PR #4706).
  function sortLabel(tab: DashboardTab): string {
    return displayTitle(tab).toLowerCase()
  }
  uniqueTabs.sort((a, b) => sortLabel(a).localeCompare(sortLabel(b), undefined, { numeric: true }))

  // Detect cross-subdomain shared paths — the "same page in dev2us +
  // dev11us + qaus" pattern that floods multi-env cards with near-
  // duplicates. A path (pathname + search + hash) present in 2+ named
  // subdomains gets folded into a single chip that carries an env-pill
  // stack; those tabs are then excluded from the per-subdomain sections
  // below so they don't appear twice.
  const foldedTabUrls = new Set<string>()
  const foldGroups: DashboardTab[][] = [] // each entry is an array of tabs sharing the same path
  {
    const pathMap = new Map<string, DashboardTab[]>()
    for (const tab of uniqueTabs) {
      try {
        const parsed = new URL(tab.url)
        const sub = subdomainPrefix(parsed.hostname, group.domain)
        if (!sub) continue // root-level tabs have no env to compare
        const pathKey = parsed.pathname + parsed.search + parsed.hash
        if (!pathMap.has(pathKey)) pathMap.set(pathKey, [])
        pathMap.get(pathKey)?.push(tab)
      } catch {
        // unparseable URL — skip
      }
    }
    for (const tabs of pathMap.values()) {
      const subs = new Set<string>()
      for (const t of tabs) {
        try {
          subs.add(subdomainPrefix(new URL(t.url).hostname, group.domain))
        } catch {}
      }
      if (subs.size < 2) continue
      foldGroups.push(tabs)
      tabs.forEach((t) => foldedTabUrls.add(t.url))
    }
  }

  // Group tabs by subdomain/port within the card, EXCLUDING any tabs
  // that got folded into the shared section above. Root tabs (no
  // subdomain or lone "www") sit under an empty-string key.
  const bySubdomain = new Map<string, DashboardTab[]>()
  for (const tab of uniqueTabs) {
    if (foldedTabUrls.has(tab.url)) continue
    let key = ''
    try {
      const parsed = new URL(tab.url)
      if (parsed.hostname === 'localhost' && parsed.port) {
        key = parsed.port
      } else {
        key = subdomainPrefix(parsed.hostname, group.domain)
      }
    } catch {}
    if (!bySubdomain.has(key)) bySubdomain.set(key, [])
    bySubdomain.get(key)?.push(tab)
  }

  // Sort policy: root tabs (empty key) first, then the rest
  // alphabetically by subdomain. Alphabetical is predictable — the
  // same subdomain always lands in the same spot across refreshes,
  // regardless of tab counts or Chrome tab-strip order.
  const sections = [...bySubdomain.entries()].sort((a, b) => {
    if (a[0] === b[0]) return 0
    if (a[0] === '') return -1
    if (b[0] === '') return 1
    return a[0].localeCompare(b[0])
  })
  const multipleSections = sections.length > 1
  // Single-subdomain card: hoist the subdomain up to a pill next to
  // the card title so chips don't repeat the prefix on every row.
  // Only for non-empty keys — all-root cards don't need a pill.
  const singleSubdomainKey = sections.length === 1 && sections[0][0] !== '' ? sections[0][0] : ''

  // Localhost cards use the port as the "subdomain" key (see the
  // bySubdomain loop above), so the pill / header for those should
  // render as `:3000` — prefix colon, no trailing dot — instead of
  // the FQDN-style `dev2us.` treatment. Flag it here so <DomainCard>
  // + <SubdomainSection> + the CSS pseudo-elements can branch.
  const isPortGroup = group.domain === 'localhost'
  const singleSubdomainIsPort = isPortGroup && !!singleSubdomainKey

  // Per-chip data builder. Closes over group + urlCounts so the
  // section loop below can call it without repeating context.
  // Returns the display-only fields <PageChip> needs — title,
  // favicon URL, tooltip, prefix/path/pg/dupe annotations. Phase 5
  // replaced the old renderChip HTML-string emitter with this
  // data-shape so components can render declaratively.
  function buildChipData(
    tab: DashboardTab,
    showPrefix: boolean,
    pathSuffix: string,
    pathGroupLabel: string,
    stripLabel = '',
    { iconOnly = false }: { iconOnly?: boolean } = {}
  ): DashboardChipData {
    let parsed: URL | null = null
    try {
      parsed = new URL(tab.url)
    } catch {}
    const presentation = titlePresentation(tab)
    const label = presentation.displayTitle
    let subPrefix = ''
    let portPrefix = ''
    if (parsed && showPrefix) {
      if (parsed.hostname === 'localhost' && parsed.port) portPrefix = parsed.port
      else subPrefix = subdomainPrefix(parsed.hostname, group.domain)
    }
    const leadPrefix = subPrefix || portPrefix
    const pgLabel = pathGroupLabel || ''
    const rawSegments = insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
      stripPgLabel(label, stripLabel || pgLabel),
      presentation.suppressedTitlePartsBeforeStructuralTail
    )
    // Inject zero-width spaces into long unbreakable tokens so the
    // browser can break them if layout needs to — without us setting
    // global `word-break: break-all` (which would also break SHORT
    // words awkwardly, e.g. "Highlight c / ode"). ZWSP is invisible
    // and doesn't render as a hyphen, so line-2 breaks on these long
    // tokens read as a clipped edge (the fade mask handles the
    // visual). Threshold 15 chars + every 5-char split keeps natural
    // English words (which are almost always <15 chars outside
    // "internationalization"-class outliers) intact and only tags
    // compound identifiers / usernames / hashes / slugs. Page-chip
    // tooltip rendering intentionally reuses these display segments so
    // highlighting and visual structure match the source chip.
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    const tooltip = [leadPrefix, label, pathSuffix].filter(Boolean).join(' · ')
    const grouped = isGroupedTab(tab)
    const { activeInOtherWindow, activeChipFrame } = activeFrameStateForDuplicateSet(tabsByUrl.get(tab.url) || [tab], currentWindowId)
    return {
      tabUrl: tab.url,
      rawUrl: tab.rawUrl || tab.url,
      sourceType: tab.sourceType || 'tab',
      leadPrefix,
      pathGroupLabel: pgLabel,
      displaySegments,
      suppressedTitleParts: presentation.suppressedTitleParts,
      pathSuffix: pathSuffix || '',
      tooltip,
      dupeCount: urlCounts[tab.url] || 1,
      faviconUrl: pickDashboardChipFavicon(tab),
      isGrouped: grouped,
      groupDotColor: grouped ? groupDotColor(tab.groupId) : null,
      isApp: !!tab.isApp,
      activeInOtherWindow,
      activeChipFrame,
      iconOnly,
      envs: null
    }
  }

  // Per-section visible limit. With multiple subdomain sections in one
  // card, a global 8 would flood the card; 5 per section keeps each
  // sub-group scannable while the card stays compact.
  const CHIPS_PER_SECTION = 5

  // "+N more" collapses hidden chips behind an expander button. But
  // when N would be 1, the button itself takes about the same vertical
  // space as rendering the one chip inline — so the collapse saves
  // nothing. Roll that last chip into the visible set instead.
  //
  // While filtering we bypass the split entirely: every chip that
  // made it through the filter is, by definition, something the user
  // is trying to see. Collapsing any of them behind "+N more" would
  // defeat the filter. (Previously filter.js forced all .page-chips-
  // overflow elements to display:contents; the VM handles it now.)
  function splitForOverflow<T>(tabs: T[]): { vis: T[]; hid: T[] } {
    if (filtering || tabs.length <= CHIPS_PER_SECTION + 1) {
      return { vis: tabs, hid: [] }
    }
    return { vis: tabs.slice(0, CHIPS_PER_SECTION), hid: tabs.slice(CHIPS_PER_SECTION) }
  }

  // Order chips within a cluster by sub-category (if the adapter
  // provided one), then by their display-label order (preserved via
  // stable sort, since the input tabs are already sorted by display
  // label above). Unknown categories fall to 'other'.
  const CATEGORY_ORDER: Record<PathCategory, number> = { pull: 0, issue: 1, commit: 2, code: 3, other: 4 }
  const categoryRank = (category?: PathGroupResult['category']) => CATEGORY_ORDER[category ?? 'other']

  function titleCollisionPathByUrl(groupTabs: DashboardTab[]): Map<string, string> {
    const pathByUrl = new Map<string, string>()
    const sameTitle = new Map<string, DashboardTab[]>()
    for (const t of groupTabs) {
      const titleKey = displayTitle(t).toLowerCase()
      if (!sameTitle.has(titleKey)) sameTitle.set(titleKey, [])
      sameTitle.get(titleKey)?.push(t)
    }
    for (const collided of sameTitle.values()) {
      if (collided.length < 2) continue
      const suffixes = disambiguatingPaths(collided.map((t) => t.url))
      collided.forEach((t, i) => pathByUrl.set(t.url, suffixes[i] ?? ''))
    }
    return pathByUrl
  }

  function titleVariantLabelForUrl(url: string): string {
    try {
      const parsed = new URL(url)
      return `${parsed.pathname || '/'}${parsed.search}${parsed.hash}` || '/'
    } catch {
      return url || '/'
    }
  }

  function titleVariantGroupChip(variants: DashboardChipData[]): DashboardChipData {
    const representative = variants[0]
    const activeInCurrentWindow = variants.some((variant) => !!variant.activeChipFrame && !variant.activeInOtherWindow)
    const activeInOtherWindow = !activeInCurrentWindow && variants.some((variant) => !!variant.activeInOtherWindow)
    return {
      ...representative,
      pathSuffix: '',
      tooltip: `${representative.tooltip} · ${variants.length} URL variants`,
      dupeCount: 1,
      activeChipFrame: activeInCurrentWindow || activeInOtherWindow,
      activeInOtherWindow,
      titleVariantChips: variants
    }
  }

  function buildChipDataList(contentTabs: DashboardTab[], showChipPrefix: boolean, pathByUrl: Map<string, string>, pathGroupLabel: string, stripLabel = ''): DashboardChipData[] {
    const entries: ChipBuildEntry[] = contentTabs.map((tab) => {
      const pathSuffix = pathByUrl.get(tab.url) || ''
      return {
        tab,
        chip: buildChipData(tab, showChipPrefix, pathSuffix, pathGroupLabel, stripLabel),
        titleKey: displayTitle(tab).trim().toLowerCase()
      }
    })
    const entriesByTitle = new Map<string, ChipBuildEntry[]>()
    for (const entry of entries) {
      if (!entry.titleKey) continue
      if (!entriesByTitle.has(entry.titleKey)) entriesByTitle.set(entry.titleKey, [])
      entriesByTitle.get(entry.titleKey)?.push(entry)
    }
    const groupedTitleKeys = new Set(
      [...entriesByTitle.entries()]
        .filter(([, groupEntries]) => groupEntries.length > 1 && new Set(groupEntries.map((entry) => entry.tab.url)).size > 1)
        .map(([titleKey]) => titleKey)
    )
    const emittedTitleKeys = new Set<string>()
    const result: DashboardChipData[] = []
    for (const entry of entries) {
      if (!groupedTitleKeys.has(entry.titleKey)) {
        result.push(entry.chip)
        continue
      }
      if (emittedTitleKeys.has(entry.titleKey)) continue
      emittedTitleKeys.add(entry.titleKey)
      const variants = (entriesByTitle.get(entry.titleKey) || []).map((variantEntry) => {
        const variant = variantEntry.chip
        return {
          ...variant,
          pathSuffix: variant.pathSuffix || titleVariantLabelForUrl(variant.tabUrl),
          titleVariantChips: undefined
        }
      })
      result.push(titleVariantGroupChip(variants))
    }
    return result
  }

  function buildSectionContent(contentTabs: DashboardTab[], showChipPrefix: boolean, redundantLabels: Set<string>): SectionContentVM {
    // Path-group pills: resolve each tab's path group (github repo,
    // jira project, contentful env, etc.) and only keep labels whose
    // group has ≥2 members in this content group. A lone group is
    // usually silent clutter — the signal is "these belong together,"
    // which takes at least two chips to convey.
    //
    // Exception: adapters can opt in to `alwaysCluster: true` to
    // bypass the threshold. Jira uses this so ticket keys stay as
    // their own cluster even at member-count 1 — a self-contained
    // identifier and, more importantly, a position-stable anchor.
    //
    // Extra guardrail: drop labels already carried by the parent
    // domain/subdomain/path-section context.
    const pgByUrl = new Map<string, PathGroupResult>()
    const pgKeyCount = new Map<string, number>()
    for (const t of contentTabs) {
      const pg = resolvePathGroup(t.url)
      if (!pg) continue
      pgByUrl.set(t.url, pg)
      pgKeyCount.set(pg.key, (pgKeyCount.get(pg.key) || 0) + 1)
    }
    const pgLabelByUrl = new Map<string, string>()
    for (const [url, pg] of pgByUrl) {
      if (!pg.alwaysCluster && (pgKeyCount.get(pg.key) ?? 0) < 2) continue
      if (redundantLabels.has(pg.label)) continue
      pgLabelByUrl.set(url, pg.label)
    }

    // Build cluster blocks (≥2 members share a path-group label) and
    // a singleton block. Clusters render as labeled sub-sections; the
    // pill becomes the header and inner chips skip their per-chip
    // pill. Singletons follow flat with no header. Each block manages
    // its OWN visible/hidden split and its OWN "+N more" expander.
    const clusterByLabel = new Map<string, DashboardTab[]>()
    const singletonTabs: DashboardTab[] = []
    for (const t of contentTabs) {
      const lbl = pgLabelByUrl.get(t.url)
      if (!lbl) {
        singletonTabs.push(t)
        continue
      }
      if (!clusterByLabel.has(lbl)) clusterByLabel.set(lbl, [])
      clusterByLabel.get(lbl)?.push(t)
    }
    const sortedClusters = [...clusterByLabel.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))

    // Pull requests deserve their own section under a repo: they're
    // action items ("review me"), not browsing state ("I'm reading
    // this file"). Splitting them into a sibling sub-cluster lets
    // each half claim its own CHIPS_PER_SECTION limit instead of
    // fighting over one.
    const rawClusters: Array<{ label: string; tabs: DashboardTab[]; key: string; isPR: boolean }> = []
    for (const [lbl, tabs] of sortedClusters) {
      const prTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category === 'pull')
      const nonPrTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category !== 'pull')
      if (prTabs.length >= 2 && nonPrTabs.length >= 1) {
        rawClusters.push({ label: lbl, tabs: nonPrTabs, key: lbl, isPR: false })
        rawClusters.push({ label: lbl, tabs: prTabs, key: lbl + ':pr', isPR: true })
      } else {
        const allArePRs = prTabs.length === tabs.length && tabs.length > 0
        rawClusters.push({ label: lbl, tabs, key: lbl, isPR: allArePRs })
      }
    }

    const clusters = rawClusters.map(({ label, tabs, key, isPR }) => {
      const orderedTabs = tabs.slice().sort((a, b) => {
        const aCat = categoryRank(pgByUrl.get(a.url)?.category)
        const bCat = categoryRank(pgByUrl.get(b.url)?.category)
        return aCat - bCat
      })
      // Title-collision disambiguation is scoped to the rendered
      // group. If path-group headers already separate same-title
      // chips, URL crumbs would duplicate that structural signal.
      const pathByUrl = titleCollisionPathByUrl(orderedTabs)
      const chipData = buildChipDataList(orderedTabs, showChipPrefix, pathByUrl, '', label)
      const { vis, hid } = splitForOverflow(chipData)
      const clusterClosable = allowMutations ? orderedTabs.filter((t) => !isGroupedTab(t)) : []
      return {
        key,
        label,
        isPR,
        count: tabs.length,
        closableUrls: clusterClosable.map((t) => t.url),
        visibleChips: vis,
        hiddenChips: hid,
        hiddenCount: hid.length
      }
    })

    const flatPathByUrl = titleCollisionPathByUrl(singletonTabs)
    const flatChipData = buildChipDataList(singletonTabs, showChipPrefix, flatPathByUrl, '')
    const { vis: flatVisibleChips, hid: flatHiddenChips } = splitForOverflow(flatChipData)

    return {
      hasFlat: singletonTabs.length > 0,
      flatVisibleChips,
      flatHiddenChips,
      flatHiddenCount: flatHiddenChips.length,
      clusters
    }
  }

  if (isAppsGroup) {
    const appChips = uniqueTabs.map((tab) => buildChipData(tab, false, '', '', '', { iconOnly: true }))
    const vmClosableCount = displayMode === 'unmatched' || !allowMutations ? 0 : closableCount
    const vmClosableExtras = displayMode === 'unmatched' || !allowMutations ? 0 : closableExtras
    const vmClosableDupeUrls = displayMode === 'unmatched' || !allowMutations ? [] : closableDupeUrls
    return {
      stableId,
      isHidden: false,
      displayMode,
      filtering,
      tabCount,
      totalTabCount,
      tabCountLabel,
      tabCountTitle,
      closableCount: vmClosableCount,
      closableCountLabel:
        closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`,
      closableDupeUrls: vmClosableDupeUrls,
      closableExtras: vmClosableExtras,
      singleSubdomainKey: '',
      singleSubdomainIsPort: false,
      displayName: group.label || 'Apps',
      suppressedTitleParts: [],
      allSuppressedTitleParts: [],
      sections: [
        {
          key: '__apps__',
          sectionCount: tabCount,
          sectionClosableUrls: displayMode === 'unmatched' || !allowMutations ? [] : closableTabs.map((tab) => tab.url),
          showHeader: false,
          isShared: false,
          isPort: false,
          hasFlat: true,
          flatVisibleChips: appChips,
          flatHiddenChips: [],
          flatHiddenCount: 0,
          suppressedTitleParts: [],
          clusters: [],
          websitePathSections: []
        }
      ]
    }
  }

  // Folded (cross-env) chip data — one chip representing the same path
  // present in 2+ subdomains. The env-pill stack replaces the usual
  // subdomain prefix; clicking a pill focuses that env's tab and the
  // chip's close button (handled in PageChip) closes every env copy.
  function buildFoldedChipData(tabs: DashboardTab[]): DashboardChipData {
    const primary = tabs[0]
    if (!primary) throw new Error('Folded chip requires at least one tab')
    const presentation = titlePresentation(primary)
    const label = presentation.displayTitle
    const rawSegments = stripPgLabel(label, '')
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    // Sort envs by prefix with numeric-aware compare so dev2us lands
    // before dev11us (plain lexicographic would give dev11us, dev2us,
    // qaus — technically right but wrong for a human-natural read).
    // Stable across refreshes since `tabs` is derived from the same
    // pathMap + subdomain prefix every time.
    const envs = tabs
      .map((t) => {
        let sub = ''
        try {
          sub = subdomainPrefix(new URL(t.url).hostname, group.domain)
        } catch {}
        return {
          prefix: sub || '?',
          tabUrl: t.url,
          rawUrl: t.rawUrl || t.url,
          activeInOtherWindow: isActiveInOtherWindow(t, currentWindowId)
        }
      })
      .sort((a, b) => a.prefix.localeCompare(b.prefix, undefined, { numeric: true }))
    const tooltip = [envs.map((e) => e.prefix).join(' · '), label].filter(Boolean).join(' · ')
    return {
      tabUrl: primary.url,
      rawUrl: primary.rawUrl || primary.url,
      sourceType: primary.sourceType || 'tab',
      leadPrefix: '',
      pathGroupLabel: '',
      displaySegments,
      suppressedTitleParts: aggregateSuppressedTitleParts(tabs),
      pathSuffix: '',
      tooltip,
      dupeCount: 1,
      faviconUrl: pickDashboardChipFavicon(primary),
      isGrouped: false,
      groupDotColor: null,
      // Folded chip reads as "app" only when every env tab behind it
      // is running in an app window — a mixed set isn't clearly one
      // or the other, so we bias toward "not app" (no dashed marker).
      isApp: tabs.every((t) => t.isApp),
      activeInOtherWindow: envs.some((env) => env.activeInOtherWindow),
      activeChipFrame: envs.some((env) => env.activeInOtherWindow),
      envs
    }
  }

  // Assemble the shared section (appears first in the card when any
  // fold groups exist). It's a virtual subdomain: one flat list of
  // folded chips, no cluster sub-sections. Close-section closes every
  // tab across every env in every fold group.
  let sharedSectionData: DashboardSectionVM | null = null
  if (foldGroups.length > 0) {
    const sortedFolds = foldGroups.slice().sort((a, b) => sortLabel(a[0]).localeCompare(sortLabel(b[0]), undefined, { numeric: true }))
    const foldedChipData = sortedFolds.map((tabs) => buildFoldedChipData(tabs))
    const { vis, hid } = splitForOverflow(foldedChipData)
    const sharedClosableUrls = allowMutations ? sortedFolds.flatMap((tabs) => tabs.filter((t) => !isGroupedTab(t)).map((t) => t.url)) : []
    const totalFoldedTabs = sortedFolds.reduce((sum, tabs) => sum + tabs.length, 0)
    sharedSectionData = {
      key: '__shared__',
      sectionCount: totalFoldedTabs,
      sectionClosableUrls: sharedClosableUrls,
      showHeader: false,
      isShared: true,
      hasFlat: true,
      flatVisibleChips: vis,
      flatHiddenChips: hid,
      flatHiddenCount: hid.length,
      suppressedTitleParts: [],
      clusters: [],
      websitePathSections: []
    }
  }

  const sectionsData: DashboardSectionVM[] = sections.map(([key, sectionTabs]) => {
    // Header appears only when a card has 2+ subdomain sections AND
    // the section isn't the empty-key "root" (card title already says
    // the root). When shown, the header replaces the per-chip prefix —
    // repeating "dev2ca" on every chip under a "dev2ca" header is noise.
    const showHeader = multipleSections && key !== ''
    // Suppress chip prefix whenever the subdomain info is shown
    // elsewhere — either a section header (multi-subdomain card) or
    // the card-title pill (single-subdomain card).
    const showChipPrefix = !showHeader && !singleSubdomainKey

    const parentRedundantLabels = new Set([key, group.domain].filter(Boolean))
    const websitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const genericWebsitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const tabsWithoutWebsitePathSection: DashboardTab[] = []
    for (const tab of sectionTabs) {
      const websitePathSection = resolveWebsitePathSection(tab.url)
      if (websitePathSection) {
        const bucket = websitePathBuckets.get(websitePathSection.key) || { ...websitePathSection, tabs: [] }
        bucket.tabs.push(tab)
        websitePathBuckets.set(websitePathSection.key, bucket)
        continue
      }

      const genericWebsitePathSection = resolveGenericWebsitePathSection(tab.url)
      if (!genericWebsitePathSection) {
        tabsWithoutWebsitePathSection.push(tab)
        continue
      }

      const bucket = genericWebsitePathBuckets.get(genericWebsitePathSection.key) || { ...genericWebsitePathSection, tabs: [] }
      bucket.tabs.push(tab)
      genericWebsitePathBuckets.set(genericWebsitePathSection.key, bucket)
    }
    for (const bucket of genericWebsitePathBuckets.values()) {
      if (bucket.tabs.length >= 2) {
        websitePathBuckets.set(bucket.key, bucket)
      } else {
        tabsWithoutWebsitePathSection.push(...bucket.tabs)
      }
    }
    const websitePathBucketList = [...websitePathBuckets.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    const showWebsitePathSections =
      websitePathBucketList.length > 1 ||
      (websitePathBucketList.length === 1 && websitePathBucketList[0].tabs.length >= 2 && tabsWithoutWebsitePathSection.length > 0)
    const parentTabs = showWebsitePathSections ? tabsWithoutWebsitePathSection : sectionTabs
    const parentContent = buildSectionContent(parentTabs, showChipPrefix, parentRedundantLabels)
    const websitePathSections: DashboardWebsitePathSectionVM[] = showWebsitePathSections
      ? websitePathBucketList.map((websitePathSection) => {
          const content = buildSectionContent(
            websitePathSection.tabs,
            showChipPrefix,
            new Set([...parentRedundantLabels, websitePathSection.label])
          )
          return {
            key: websitePathSection.key,
            label: websitePathSection.label,
            sectionCount: websitePathSection.tabs.length,
            sectionClosableUrls: allowMutations ? websitePathSection.tabs.filter((t) => !isGroupedTab(t)).map((t) => t.url) : [],
            ...content,
            suppressedTitleParts: []
          }
        })
      : []

    // Closable URLs for the subdomain-level close button in the
    // SubdomainSection header (shown only on multi-subdomain cards,
    // where the header itself is visible). Filters out tabs already
    // in a Chrome tab group — matches the preserveGroups semantics
    // used elsewhere. Union of every chip's URL in this section.
    const sectionClosableUrls = allowMutations ? sectionTabs.filter((t) => !isGroupedTab(t)).map((t) => t.url) : []

    return {
      key,
      sectionCount: sectionTabs.length,
      sectionClosableUrls,
      showHeader,
      isShared: false,
      isPort: isPortGroup,
      ...parentContent,
      suppressedTitleParts: [],
      websitePathSections
    }
  })

  // Prepend the cross-env fold section so it sits above the per-
  // subdomain sections — it reads as a TL;DR of "these pages are the
  // same across your envs, you probably want to see them grouped."
  if (sharedSectionData) sectionsData.unshift(sharedSectionData)

  function scopeSuppressedTitleParts(sectionsToScope: DashboardSectionVM[]) {
    type ScopeTracker = {
      part: DashboardTitleSuppression
      sectionIndexes: Set<number>
      flatSectionIndexes: Set<number>
      clusterRefs: Set<string>
      websitePathSectionRefs: Set<string>
      websitePathFlatRefs: Set<string>
      websitePathClusterRefs: Set<string>
    }

    const trackers = new Map<string, ScopeTracker>()
    for (const part of suppressedTitleParts) {
      trackers.set(titleSuppressionKey(part.text), {
        part,
        sectionIndexes: new Set(),
        flatSectionIndexes: new Set(),
        clusterRefs: new Set(),
        websitePathSectionRefs: new Set(),
        websitePathFlatRefs: new Set(),
        websitePathClusterRefs: new Set()
      })
    }

    function childGroupScopedPart(part: DashboardTitleSuppression, spansRenderedChildGroups: boolean): DashboardTitleSuppression {
      return hasMultipleVisibleSuppressionMeanings && spansRenderedChildGroups ? { ...part, spansRenderedChildGroups: true } : part
    }

    function clusterRef(sectionIndex: number, clusterIndex: number): string {
      return `cluster\u0000${sectionIndex}\u0000${clusterIndex}`
    }

    function websitePathSectionRef(sectionIndex: number, websitePathSectionIndex: number): string {
      return `website-path-section\u0000${sectionIndex}\u0000${websitePathSectionIndex}`
    }

    function websitePathClusterRef(sectionIndex: number, websitePathSectionIndex: number, clusterIndex: number): string {
      return `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000${clusterIndex}`
    }

    function sectionChildGroupCount(tracker: ScopeTracker, sectionIndex: number): number {
      let count = tracker.flatSectionIndexes.has(sectionIndex) ? 1 : 0
      const clusterPrefix = `cluster\u0000${sectionIndex}\u0000`
      const websitePathSectionPrefix = `website-path-section\u0000${sectionIndex}\u0000`
      for (const ref of tracker.clusterRefs) {
        if (ref.startsWith(clusterPrefix)) count += 1
      }
      for (const ref of tracker.websitePathSectionRefs) {
        if (ref.startsWith(websitePathSectionPrefix)) count += 1
      }
      return count
    }

    function websitePathChildGroupCount(tracker: ScopeTracker, sectionIndex: number, websitePathSectionIndex: number): number {
      const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
      let count = tracker.websitePathFlatRefs.has(websiteRef) ? 1 : 0
      const prefix = `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000`
      for (const ref of tracker.websitePathClusterRefs) {
        if (ref.startsWith(prefix)) count += 1
      }
      return count
    }

    function recordChip(
      chip: DashboardChipData,
      sectionIndex: number,
      clusterIndex: number | null,
      websitePathSectionIndex: number | null = null,
      websitePathSectionClusterIndex: number | null = null
    ) {
      for (const part of chip.suppressedTitleParts || []) {
        const tracker = trackers.get(titleSuppressionKey(part))
        if (!tracker) continue
        tracker.sectionIndexes.add(sectionIndex)
        if (websitePathSectionIndex !== null) {
          const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
          tracker.websitePathSectionRefs.add(websiteRef)
          if (websitePathSectionClusterIndex === null) {
            tracker.websitePathFlatRefs.add(websiteRef)
          } else {
            tracker.websitePathClusterRefs.add(websitePathClusterRef(sectionIndex, websitePathSectionIndex, websitePathSectionClusterIndex))
          }
        } else if (clusterIndex === null) {
          tracker.flatSectionIndexes.add(sectionIndex)
        } else {
          tracker.clusterRefs.add(clusterRef(sectionIndex, clusterIndex))
        }
      }
    }

    sectionsToScope.forEach((section, sectionIndex) => {
      section.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.clusters.forEach((cluster, clusterIndex) => {
        cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
        cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
      })
      const sectionWebsitePathSections = section.websitePathSections ?? []
      sectionWebsitePathSections.forEach((websitePathSection, websitePathSectionIndex) => {
        websitePathSection.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.clusters.forEach((cluster, clusterIndex) => {
          cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
          cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
        })
      })
    })

    const cardParts: DashboardTitleSuppression[] = []
    const sectionPartsByIndex = new Map<number, DashboardTitleSuppression[]>()
    const clusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathSectionPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathClusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()

    for (const part of suppressedTitleParts) {
      const tracker = trackers.get(titleSuppressionKey(part.text))
      if (!tracker || tracker.sectionIndexes.size === 0) {
        cardParts.push(part)
        continue
      }

      if (
        tracker.clusterRefs.size === 1 &&
        tracker.flatSectionIndexes.size === 0 &&
        tracker.websitePathSectionRefs.size === 0
      ) {
        const clusterRefKey = [...tracker.clusterRefs][0]
        if (!clusterPartsByRef.has(clusterRefKey)) clusterPartsByRef.set(clusterRefKey, [])
        clusterPartsByRef.get(clusterRefKey)?.push(part)
        continue
      }

      if (
        tracker.websitePathClusterRefs.size === 1 &&
        tracker.websitePathFlatRefs.size === 0 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const clusterRefKey = [...tracker.websitePathClusterRefs][0]
        if (!websitePathClusterPartsByRef.has(clusterRefKey)) websitePathClusterPartsByRef.set(clusterRefKey, [])
        websitePathClusterPartsByRef.get(clusterRefKey)?.push(part)
        continue
      }

      if (
        tracker.websitePathSectionRefs.size === 1 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const websiteRef = [...tracker.websitePathSectionRefs][0]
        const [, sectionIndexText, websitePathSectionIndexText] = websiteRef.split('\u0000')
        const sectionIndex = Number(sectionIndexText)
        const websitePathSectionIndex = Number(websitePathSectionIndexText)
        if (!websitePathSectionPartsByRef.has(websiteRef)) websitePathSectionPartsByRef.set(websiteRef, [])
        websitePathSectionPartsByRef.get(websiteRef)?.push(
          childGroupScopedPart(part, websitePathChildGroupCount(tracker, sectionIndex, websitePathSectionIndex) > 1)
        )
        continue
      }

      if (tracker.sectionIndexes.size === 1) {
        const sectionIndex = [...tracker.sectionIndexes][0]
        if (!sectionPartsByIndex.has(sectionIndex)) sectionPartsByIndex.set(sectionIndex, [])
        sectionPartsByIndex.get(sectionIndex)?.push(childGroupScopedPart(part, sectionChildGroupCount(tracker, sectionIndex) > 1))
        continue
      }

      cardParts.push(childGroupScopedPart(part, tracker.sectionIndexes.size > 1))
    }

    const scopedSections = sectionsToScope.map((section, sectionIndex) => ({
      ...section,
      suppressedTitleParts: sectionPartsByIndex.get(sectionIndex) ?? [],
      clusters: section.clusters.map((cluster, clusterIndex) => ({
        ...cluster,
        suppressedTitleParts: clusterPartsByRef.get(clusterRef(sectionIndex, clusterIndex)) ?? []
      })),
      websitePathSections: (section.websitePathSections ?? []).map((websitePathSection, websitePathSectionIndex) => ({
        ...websitePathSection,
        suppressedTitleParts: websitePathSectionPartsByRef.get(websitePathSectionRef(sectionIndex, websitePathSectionIndex)) ?? [],
        clusters: websitePathSection.clusters.map((cluster, clusterIndex) => ({
          ...cluster,
          suppressedTitleParts: websitePathClusterPartsByRef.get(websitePathClusterRef(sectionIndex, websitePathSectionIndex, clusterIndex)) ?? []
        }))
      }))
    }))

    return { cardParts, scopedSections }
  }

  const { cardParts: cardSuppressedTitleParts, scopedSections: scopedSectionsData } = scopeSuppressedTitleParts(sectionsData)

  // Labels derived for the React component to consume directly.
  // closableCountLabel mirrors the original "Close all N tabs" vs
  // "Close N ungrouped tabs" split so the button text matches.
  const closableCountLabel =
    closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`

  const displayName = group.label || group.domain.replace(/^www\./, '')

  // In the secondary ("unmatched") grid, every bulk-close action is
  // suppressed — we don't want to offer a "Close 4 tabs" on a card
  // rendered as the user's NON-match set, that would close the tabs
  // they didn't type "github" about. Zero out the closable fields so
  // the buttons just don't render (components are already conditional
  // on closableCount > 0 / closableUrls.length > 0).
  const isUnmatched = displayMode === 'unmatched'
  const vmClosableCount = isUnmatched || !allowMutations ? 0 : closableCount
  const vmClosableExtras = isUnmatched || !allowMutations ? 0 : closableExtras
  const vmClosableDupeUrls = isUnmatched || !allowMutations ? [] : closableDupeUrls
  const vmSections = isUnmatched
    ? scopedSectionsData.map((s) => ({
        ...s,
        sectionClosableUrls: [],
        clusters: s.clusters.map((c) => ({ ...c, closableUrls: [] })),
        websitePathSections: (s.websitePathSections ?? []).map((websitePathSection) => ({
          ...websitePathSection,
          sectionClosableUrls: [],
          clusters: websitePathSection.clusters.map((c) => ({ ...c, closableUrls: [] }))
        }))
      }))
    : scopedSectionsData

  return {
    stableId,
    isHidden: false,
    displayMode,
    filtering,
    tabCount,
    totalTabCount,
    tabCountLabel,
    tabCountTitle,
    closableCount: vmClosableCount,
    closableCountLabel,
    closableDupeUrls: vmClosableDupeUrls,
    closableExtras: vmClosableExtras,
    singleSubdomainKey,
    singleSubdomainIsPort,
    displayName,
    suppressedTitleParts: cardSuppressedTitleParts,
    allSuppressedTitleParts: suppressedTitleParts,
    sections: vmSections
  }
}
