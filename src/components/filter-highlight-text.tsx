import type { ReactNode } from 'react'
import { matchValuesForFilterTerm, parseFilterQuery } from '../extension/filter-query.js'
import type { InlineTextRenderer } from './bionic-title-text'

const FILTER_HIGHLIGHT_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function highlightTermsForFilter(filter: string): string[] {
  const query = filter.trim()
  if (!query) return []
  return [...new Set(parseFilterQuery(query).terms.flatMap((term) => matchValuesForFilterTerm(term)))]
}

function appendTextNodes(nodes: ReactNode[], text: string, keyPrefix: string, textOffset: number, renderText: InlineTextRenderer) {
  const rendered = renderText(text, keyPrefix, textOffset)
  if (Array.isArray(rendered)) nodes.push(...rendered)
  else nodes.push(rendered)
}

export function highlightedTextNodes(text: string, highlightTerms: readonly string[], keyPrefix: string, renderText: InlineTextRenderer = (value) => value): ReactNode {
  if (!text) return text
  if (highlightTerms.length === 0) return renderText(text, keyPrefix, 0)

  const normalizedChars: string[] = []
  const originalStartIndexes: number[] = []
  const originalEndIndexes: number[] = []
  for (const { segment, index } of FILTER_HIGHLIGHT_GRAPHEME_SEGMENTER.segment(text)) {
    if (segment === '\u200B') continue
    // Lowercasing can expand a grapheme into several units ('\u0130' \u2192 'i' +
    // combining dot), so every normalized unit maps back to the complete
    // original grapheme or later highlights drift and decomposed accents split.
    const lower = segment.toLowerCase()
    for (let unit = 0; unit < lower.length; unit += 1) {
      normalizedChars.push(lower.charAt(unit))
      originalStartIndexes.push(index)
      originalEndIndexes.push(index + segment.length)
    }
  }

  const normalizedText = normalizedChars.join('')
  const ranges: Array<{ start: number, end: number }> = []
  for (const term of highlightTerms) {
    if (!term) continue
    let searchFrom = 0
    while (searchFrom < normalizedText.length) {
      const start = normalizedText.indexOf(term, searchFrom)
      if (start === -1) break
      const end = start + term.length
      ranges.push({ start, end })
      searchFrom = end
    }
  }

  if (ranges.length === 0) return renderText(text, keyPrefix, 0)

  const originalRanges: Array<{ start: number, end: number }> = []
  for (const range of ranges) {
    const start = originalStartIndexes[range.start]
    if (start === undefined) continue
    originalRanges.push({
      start,
      end: originalEndIndexes[range.end - 1] ?? text.length,
    })
  }
  originalRanges.sort((a, b) => a.start - b.start || b.end - a.end)
  const mergedRanges: Array<{ start: number, end: number }> = []
  for (const range of originalRanges) {
    const previous = mergedRanges.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      mergedRanges.push({ ...range })
    }
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  for (const range of mergedRanges) {
    const originalStart = range.start
    const originalEnd = range.end
    if (originalStart > cursor) appendTextNodes(nodes, text.slice(cursor, originalStart), `${keyPrefix}:${cursor}:${originalStart}`, cursor, renderText)
    const matchedText = text.slice(originalStart, originalEnd)
    const renderedMatch = renderText(matchedText, `${keyPrefix}:${originalStart}:${originalEnd}:match`, originalStart)
    nodes.push(
      <mark
        key={`${keyPrefix}-${originalStart}-${originalEnd}`}
        className="chip-filter-match rounded-xs bg-[rgba(234,179,8,0.42)] text-foreground [font:inherit] [corner-shape:squircle] [box-decoration-break:clone]"
      >
        {renderedMatch}
      </mark>,
    )
    cursor = originalEnd
  }

  if (cursor < text.length) appendTextNodes(nodes, text.slice(cursor), `${keyPrefix}:${cursor}:tail`, cursor, renderText)
  return nodes
}
