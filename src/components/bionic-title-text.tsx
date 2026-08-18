import type { ReactNode } from 'react'

export type InlineTextRenderer = (text: string, keyPrefix: string, textOffset: number) => ReactNode

type TextRange = { start: number, end: number }

const BIONIC_TITLE_WORD_PATTERN = /(?:\p{Script=Latin}|\p{N})(?:[\p{Script=Latin}\p{M}\p{N}\u200B]|['’](?=[\p{Script=Latin}\p{N}]))*/gu
const JIRA_TICKET_REFERENCE_PATTERN = /\b[A-Z][A-Z0-9_]+-\d+\b/g
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i
const HOSTLIKE_TITLE_HOST_PATTERN = /^(?:localhost|(?:[\w-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+))$/i
const NUMERIC_TITLE_WORD_PATTERN = /^\p{N}+$/u
const ASCII_TITLE_WORD_PATTERN = /^[\u0000-\u007F]+$/
const ASCII_NUMERIC_TITLE_WORD_PATTERN = /^\d+$/
const BIONIC_TITLE_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const BIONIC_TITLE_FIXATION_CACHE_LIMIT = 512
const bionicTitleFixationCache = new Map<string, readonly TextRange[]>()

function cleanDisplayText(text: string) {
  return text.replaceAll('\u200B', '').trim()
}

export function isUrlLikeTitle(text: string) {
  const value = cleanDisplayText(text)
  if (!value || /\s/.test(value)) return false
  if (URL_SCHEME_PATTERN.test(value)) return true
  const parsed = URL.parse(`https://${value}`)
  return parsed !== null && HOSTLIKE_TITLE_HOST_PATTERN.test(parsed.hostname)
}

function findJiraTicketReferenceRanges(text: string): TextRange[] {
  const normalizedChars: string[] = []
  const originalIndexes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === '\u200B') continue
    normalizedChars.push(char)
    originalIndexes.push(index)
  }

  const ranges: TextRange[] = []
  const normalizedText = normalizedChars.join('')
  for (const match of normalizedText.matchAll(JIRA_TICKET_REFERENCE_PATTERN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    ranges.push({
      start: originalIndexes[start] ?? 0,
      end: originalIndexes[end] ?? text.length,
    })
  }
  return ranges
}

function overlapsTextRange(start: number, end: number, ranges: readonly TextRange[]) {
  return ranges.some((range) => start < range.end && end > range.start)
}

function bionicTitleFixationEnd(word: string): number {
  if (ASCII_TITLE_WORD_PATTERN.test(word)) {
    if (ASCII_NUMERIC_TITLE_WORD_PATTERN.test(word)) return 0
    return word.length <= 3 ? 1 : Math.ceil(word.length / 2)
  }
  if (NUMERIC_TITLE_WORD_PATTERN.test(word.replaceAll('\u200B', ''))) return 0

  const visibleSegmentEnds: number[] = []
  for (const { segment, index } of BIONIC_TITLE_GRAPHEME_SEGMENTER.segment(word)) {
    if (segment === '\u200B') continue
    visibleSegmentEnds.push(index + segment.length)
  }
  const fixationLength = visibleSegmentEnds.length <= 3
    ? 1
    : Math.ceil(visibleSegmentEnds.length / 2)
  return visibleSegmentEnds[fixationLength - 1] ?? 0
}

function computeBionicTitleFixationRanges(text: string): readonly TextRange[] {
  if (!text || isUrlLikeTitle(text)) return []

  const protectedRanges = findJiraTicketReferenceRanges(text)
  const fixationRanges: TextRange[] = []
  for (const match of text.matchAll(BIONIC_TITLE_WORD_PATTERN)) {
    const word = match[0]
    const start = match.index ?? 0
    const end = start + word.length
    if (overlapsTextRange(start, end, protectedRanges)) continue

    const fixationEnd = bionicTitleFixationEnd(word)
    if (fixationEnd <= 0) continue
    fixationRanges.push({ start, end: start + fixationEnd })
  }
  return fixationRanges
}

function findBionicTitleFixationRanges(text: string): readonly TextRange[] {
  const cached = bionicTitleFixationCache.get(text)
  if (cached) return cached

  const fixationRanges = computeBionicTitleFixationRanges(text)
  if (bionicTitleFixationCache.size >= BIONIC_TITLE_FIXATION_CACHE_LIMIT) {
    const oldestTitle = bionicTitleFixationCache.keys().next().value
    if (oldestTitle !== undefined) bionicTitleFixationCache.delete(oldestTitle)
  }
  bionicTitleFixationCache.set(text, fixationRanges)
  return fixationRanges
}

function bionicTitleTextNodes(
  text: string,
  keyPrefix: string,
  textOffset: number,
  fixationRanges: readonly TextRange[],
): ReactNode {
  if (!text) return text

  const nodes: ReactNode[] = []
  const fragmentEnd = textOffset + text.length
  let cursor = 0
  for (const range of fixationRanges) {
    const rangeStart = Math.max(range.start, textOffset)
    const rangeEnd = Math.min(range.end, fragmentEnd)
    if (rangeStart >= rangeEnd) continue

    const localStart = rangeStart - textOffset
    const localEnd = rangeEnd - textOffset
    if (localStart > cursor) nodes.push(text.slice(cursor, localStart))
    nodes.push(
      <span key={`${keyPrefix}:${rangeStart}:fixation`} className="chip-title-fixation font-semibold">
        {text.slice(localStart, localEnd)}
      </span>,
    )
    cursor = localEnd
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes.length > 0 ? nodes : text
}

export function createBionicTitleTextRenderer(titleText: string): InlineTextRenderer {
  const fixationRanges = findBionicTitleFixationRanges(titleText)
  return (text, keyPrefix, textOffset) => bionicTitleTextNodes(text, keyPrefix, textOffset, fixationRanges)
}
