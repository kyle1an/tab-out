import type { ReactNode } from 'react'
import { matchValuesForFilterTerm, parseFilterQuery } from '../extension/filter-query.js'
import type { InlineTextRenderer } from './bionic-title-text'

export type HighlightMode = 'parsed' | 'legacy'

export function highlightTermsForFilter(filter: string, mode: HighlightMode): string[] {
  const query = filter.trim()
  if (!query) return []
  if (mode === 'legacy') return [query.toLowerCase()]
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
  const originalIndexes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\u200B') continue
    // Lowercase per character: toLowerCase can expand a character into several
    // units ('\u0130' \u2192 'i' + combining dot), so each unit must map back to its own
    // original index or every later highlight range drifts.
    const lower = char.toLowerCase()
    for (let unit = 0; unit < lower.length; unit += 1) {
      normalizedChars.push(lower[unit])
      originalIndexes.push(index)
    }
  }

  const normalizedText = normalizedChars.join('')
  const ranges: Array<{ start: number; end: number }> = []
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

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const mergedRanges: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      mergedRanges.push({ ...range })
    }
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  for (const range of mergedRanges) {
    const originalStart = originalIndexes[range.start]
    const originalEnd = range.end < originalIndexes.length ? originalIndexes[range.end] : text.length
    if (originalStart > cursor) appendTextNodes(nodes, text.slice(cursor, originalStart), `${keyPrefix}:${cursor}:${originalStart}`, cursor, renderText)
    nodes.push(
      <mark
        key={`${keyPrefix}-${originalStart}-${originalEnd}`}
        className="chip-filter-match rounded-[2px] bg-[rgba(234,179,8,0.42)] text-foreground [font:inherit] [corner-shape:squircle] [-webkit-box-decoration-break:clone] [box-decoration-break:clone]"
      >
        {text.slice(originalStart, originalEnd)}
      </mark>
    )
    cursor = originalEnd
  }

  if (cursor < text.length) appendTextNodes(nodes, text.slice(cursor), `${keyPrefix}:${cursor}:tail`, cursor, renderText)
  return nodes
}
