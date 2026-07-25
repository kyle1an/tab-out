import type { ReactNode } from 'react'

export type InlineTextRenderer = (text: string, keyPrefix: string, textOffset: number) => ReactNode

type ProtectedTextRange = { start: number; end: number }

const BIONIC_TITLE_WORD_PATTERN = /[A-Za-z0-9_\u200B]+/g
const JIRA_TICKET_REFERENCE_PATTERN = /\b[A-Z][A-Z0-9_]+-\d+\b/g
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i
const HOSTLIKE_TITLE_PATTERN = /^(?:localhost(?::\d+)?|(?:[\w-]+\.)+[a-z]{2,})(?:[/?#:]|$)/i
const BIONIC_TITLE_MIN_WORD_LENGTH = 4
const ACRONYM_LIKE_TITLE_WORD_PATTERN = /^[A-Z0-9_]+$/
const NUMERIC_TITLE_WORD_PATTERN = /^\d+$/
const BIONIC_TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'if',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'vs',
  'with'
])

function cleanDisplayText(text: string) {
  return text.replace(/\u200B/g, '').trim()
}

export function isUrlLikeTitle(text: string) {
  const value = cleanDisplayText(text)
  if (!value || /\s/.test(value)) return false
  if (URL_SCHEME_PATTERN.test(value)) return true
  return HOSTLIKE_TITLE_PATTERN.test(value)
}

function findJiraTicketReferenceRanges(text: string): ProtectedTextRange[] {
  const normalizedChars: string[] = []
  const originalIndexes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === '\u200B') continue
    normalizedChars.push(char)
    originalIndexes.push(index)
  }

  const ranges: ProtectedTextRange[] = []
  const normalizedText = normalizedChars.join('')
  for (const match of normalizedText.matchAll(JIRA_TICKET_REFERENCE_PATTERN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    ranges.push({
      start: originalIndexes[start] ?? 0,
      end: originalIndexes[end] ?? text.length
    })
  }
  return ranges
}

function overlapsProtectedTextRange(start: number, end: number, protectedRanges: readonly ProtectedTextRange[]) {
  return protectedRanges.some((range) => start < range.end && end > range.start)
}

function isBionicTitleWordCandidate(word: string) {
  const value = cleanDisplayText(word)
  if (value.length < BIONIC_TITLE_MIN_WORD_LENGTH) return false
  if (BIONIC_TITLE_STOP_WORDS.has(value.toLowerCase())) return false
  if (NUMERIC_TITLE_WORD_PATTERN.test(value)) return false
  if (ACRONYM_LIKE_TITLE_WORD_PATTERN.test(value) && /[A-Z]/.test(value)) return false
  return true
}

function bionicTitleFixationLength(word: string) {
  if (!isBionicTitleWordCandidate(word)) return 0
  const visibleLength = cleanDisplayText(word).length
  return Math.min(6, Math.ceil(visibleLength * 0.42))
}

function splitBionicTitleWord(word: string, fixationLength: number): [string, string] {
  if (fixationLength <= 0) return ['', word]

  let visibleCount = 0
  for (let index = 0; index < word.length; index += 1) {
    if (word[index] !== '\u200B') visibleCount += 1
    if (visibleCount >= fixationLength) return [word.slice(0, index + 1), word.slice(index + 1)]
  }
  return [word, '']
}

function bionicTitleTextNodes(
  text: string,
  keyPrefix: string,
  textOffset = 0,
  protectedRanges: readonly ProtectedTextRange[] = findJiraTicketReferenceRanges(text)
): ReactNode {
  if (!text) return text
  if (isUrlLikeTitle(text)) return text

  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(BIONIC_TITLE_WORD_PATTERN)) {
    const word = match[0]
    const start = match.index ?? 0
    const end = start + word.length
    if (start > cursor) nodes.push(text.slice(cursor, start))

    const fixationLength = bionicTitleFixationLength(word)
    if (overlapsProtectedTextRange(textOffset + start, textOffset + end, protectedRanges)) {
      nodes.push(word)
    } else if (fixationLength > 0) {
      const [fixation, rest] = splitBionicTitleWord(word, fixationLength)
      nodes.push(
        <span key={`${keyPrefix}:${start}:fixation`} className="chip-title-fixation font-semibold">
          {fixation}
        </span>
      )
      if (rest) nodes.push(rest)
    } else {
      nodes.push(word)
    }

    cursor = end
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes.length > 0 ? nodes : text
}

export function createBionicTitleTextRenderer(titleText: string): InlineTextRenderer {
  const protectedRanges = findJiraTicketReferenceRanges(titleText)
  return (text, keyPrefix, textOffset) => bionicTitleTextNodes(text, keyPrefix, textOffset, protectedRanges)
}
