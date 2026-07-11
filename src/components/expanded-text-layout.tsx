import type { ReactNode } from 'react'

/* ================================================================
   Expanded-text layout primitives — the shared core of the two
   hover-expansion engines (page-chip titles in PageChip.tsx and
   history-row titles in TabHistoryPanel.tsx). Both engines measure
   rendered title text with DOM Range APIs, capture each visual line
   as an HTML string, and re-render those lines as React nodes; these
   are the pieces that were function-for-function identical.

   The per-surface drivers (line capture, measure elements, width
   search, caches) still live with their engines — they differ in
   marker handling, line classes, and cache keys. Converge them here
   only when a change proves the bodies are genuinely the same.
   ================================================================ */

/** Last painted (non-empty) client rect of a Range — where its text visually ends. */
export function paintedRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  return rects[rects.length - 1] || null
}

export function expansionLineHtmlEquals(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

/** Serialize a cloned line fragment to HTML via a detached wrapper element. */
export function fragmentHtml(document: Document, fragment: DocumentFragment) {
  const container = document.createElement('span')
  container.append(fragment)
  return container.innerHTML
}

/**
 * expandedLineContentOverflows(line, tolerancePx) — true when a captured
 * expansion line paints wider than its box: scroll overflow, or any text
 * rect ending past the line's right edge by more than the surface's
 * tolerance (chips and history rows calibrate that differently).
 */
export function expandedLineContentOverflows(line: HTMLElement, tolerancePx: number) {
  if (line.scrollWidth - line.clientWidth > tolerancePx) return true

  const lineRect = line.getBoundingClientRect()
  const win = line.ownerDocument.defaultView
  if (!win || lineRect.width <= 0) return false

  const walker = line.ownerDocument.createTreeWalker(
    line,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  const range = line.ownerDocument.createRange()

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (
          rect.width > 0 &&
          rect.right - lineRect.right > tolerancePx
        ) {
          return true
        }
      }
    }
  } finally {
    range.detach()
  }

  return false
}

/**
 * The truncation fade masks anchor their horizontal ramp to this custom
 * property instead of the element's right edge: line breaking (hyphenation,
 * unbreakable tokens) can end the last visible line well short of the box,
 * where an edge-anchored gradient fades nothing and the text hard-stops.
 */
export const TITLE_FADE_END_PROPERTY = '--title-fade-end'

/** Longest ramp in the fade gradients — keep in sync with the mask classes. */
const TITLE_FADE_RAMP_PX = 60
const TITLE_LINE_TOP_TOLERANCE_PX = 2
const TITLE_CLIP_BOTTOM_TOLERANCE_PX = 1

export type TitleLineFragmentRect = {
  top: number
  right: number
  width: number
  height: number
}

export type TitleFadeBox = {
  left: number
  top: number
  width: number
  clipHeight: number
}

/**
 * truncatedTitleFadeEndPx(fragments, box) — where the clamped title's last
 * visible line ends, in px from the element's left edge, clamped so at least
 * one fade ramp of text stays solid and the anchor never passes the box edge.
 * Fragments are inline client rects; lines below the clip height are the
 * overflow the mask hides, so they never anchor the fade.
 */
export function truncatedTitleFadeEndPx(
  fragments: readonly TitleLineFragmentRect[],
  box: TitleFadeBox
): number | null {
  const clipBottom = box.top + box.clipHeight - TITLE_CLIP_BOTTOM_TOLERANCE_PX
  let lastLineTop = Number.NEGATIVE_INFINITY
  let lastLineRight = Number.NEGATIVE_INFINITY

  for (const fragment of fragments) {
    if (fragment.width <= 0 || fragment.height <= 0 || fragment.top >= clipBottom) continue
    if (fragment.top > lastLineTop + TITLE_LINE_TOP_TOLERANCE_PX) {
      lastLineTop = fragment.top
      lastLineRight = fragment.right
    } else if (fragment.top >= lastLineTop - TITLE_LINE_TOP_TOLERANCE_PX) {
      lastLineTop = Math.max(lastLineTop, fragment.top)
      lastLineRight = Math.max(lastLineRight, fragment.right)
    }
  }

  if (lastLineRight === Number.NEGATIVE_INFINITY) return null
  const fadeEnd = Math.min(Math.max(lastLineRight - box.left, TITLE_FADE_RAMP_PX), box.width)
  return Math.round(fadeEnd * 100) / 100
}

/**
 * syncTruncatedTitleFadeEnd(titleEl, isTruncated) — measure the rendered
 * title and pin the fade anchor on the element; clears the override (falling
 * back to the box edge) when the title isn't truncated or can't be measured.
 */
export function syncTruncatedTitleFadeEnd(titleEl: HTMLElement, isTruncated: boolean) {
  if (!isTruncated) {
    titleEl.style.removeProperty(TITLE_FADE_END_PROPERTY)
    return
  }

  const rect = titleEl.getBoundingClientRect()
  const range = titleEl.ownerDocument.createRange()
  range.selectNodeContents(titleEl)
  const fadeEnd = truncatedTitleFadeEndPx(Array.from(range.getClientRects()), {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    clipHeight: titleEl.clientHeight
  })
  range.detach()

  if (fadeEnd === null) {
    titleEl.style.removeProperty(TITLE_FADE_END_PROPERTY)
    return
  }
  titleEl.style.setProperty(TITLE_FADE_END_PROPERTY, `${fadeEnd}px`)
}

type CapturedLineDomPosition = {
  node: Text
  offset: number
}

/**
 * unwrapClampedTitleLines(root) — strip clamped-title-line wrappers from a
 * cloned fragment before serializing it. The wrapper is a resting-state
 * presentation artifact; its block/no-wrap classes must not leak into
 * captured line HTML, where they would stop the expansion's tail line from
 * wrapping and leave the expanded element permanently "truncated".
 */
export function unwrapClampedTitleLines(root: ParentNode) {
  for (const line of Array.from(root.querySelectorAll('.clamped-title-line'))) {
    line.replaceWith(...Array.from(line.childNodes))
  }
}

/**
 * captureVisibleLineHtml(el, visibleLineCount) — serialize what line breaking
 * put on each visible line of a clamped title: one HTML string per line, where
 * the LAST entry runs from its line start through the end of the content
 * (including anything clipped below the clamp). Walks per-character Range
 * rects, so it only suits text-flow titles (text nodes plus inline span/mark
 * wrappers); surfaces with element markers keep their own capture engines.
 */
export function captureVisibleLineHtml(el: HTMLElement, visibleLineCount: number): string[] {
  if (visibleLineCount <= 1) return []

  const ownerDocument = el.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const elRect = el.getBoundingClientRect()
  const styles = win.getComputedStyle(el)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (elRect.height <= 0 || !lineHeight || !Number.isFinite(lineHeight)) return []

  const walker = ownerDocument.createTreeWalker(
    el,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  const range = ownerDocument.createRange()
  const lineStarts: CapturedLineDomPosition[] = []
  let lastLineIndex = -1

  while (lineStarts.length < visibleLineCount) {
    const node = walker.nextNode()
    if (!(node instanceof win.Text)) break

    const text = node.data
    for (let offset = 0; offset < text.length && lineStarts.length < visibleLineCount; offset += 1) {
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      const rect = paintedRangeRect(range)
      if (!rect) continue

      const lineIndex = Math.max(0, Math.round((rect.top - elRect.top) / lineHeight))
      if (lineIndex >= visibleLineCount) break
      if (lineIndex > lastLineIndex) {
        lineStarts.push({ node, offset })
        lastLineIndex = lineIndex
      }
    }
  }

  range.detach()
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    lineRange.setStart(start.node, start.offset)
    const next = lineStarts[index + 1]
    if (next) {
      lineRange.setEnd(next.node, next.offset)
    } else {
      lineRange.selectNodeContents(el)
      lineRange.setStart(start.node, start.offset)
    }
    const lineContents = lineRange.cloneContents()
    unwrapClampedTitleLines(lineContents)
    lines.push(fragmentHtml(ownerDocument, lineContents))
    lineRange.detach()
  }

  return lines
}

/**
 * Clamped-title rows rendered from captured lines. Each row is a no-wrap
 * block holding exactly one captured line, so earlier lines can never
 * re-wrap; the last row carries the remainder of the title and overflows
 * the clamp box horizontally. That overflow is the point: the truncation
 * fade mask always lands on glyphs instead of the gap line breaking would
 * have left, and the element keeps scroll overflow so truncation detection
 * stays true while this presentation is active.
 */
export const CLAMPED_TITLE_LINE_CLASS_NAME = 'clamped-title-line block whitespace-nowrap'

export function clampedTitleLineNodes(lineHtml: readonly string[], keyPrefix: string): ReactNode {
  return lineHtml.map((html, index) => (
    <span key={`${keyPrefix}-${index}:${html}`} className={CLAMPED_TITLE_LINE_CLASS_NAME}>
      {expansionLineNodesFromHtml(html, `${keyPrefix}-clamped-${index}`)}
    </span>
  ))
}

/**
 * expansionLineNodesFromHtml(html, keyPrefix) — rebuild a captured line's
 * HTML as React nodes, preserving only the span/mark structure (classes and
 * aria-labels) the engines themselves serialized.
 */
export function expansionLineNodesFromHtml(html: string, keyPrefix: string): ReactNode {
  if (!html || typeof document === 'undefined') return html

  const template = document.createElement('template')
  template.innerHTML = html

  function nodeFromDom(node: ChildNode, key: string): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return null

    const element = node as Element
    const children = Array.from(element.childNodes).map((child, index) => nodeFromDom(child, `${key}-${index}`))
    const className = element.getAttribute('class') || undefined
    const ariaLabel = element.getAttribute('aria-label') || undefined

    if (element.tagName.toLowerCase() === 'span') {
      return <span key={key} className={className} aria-label={ariaLabel}>{children}</span>
    }
    if (element.tagName.toLowerCase() === 'mark') {
      return <mark key={key} className={className} aria-label={ariaLabel}>{children}</mark>
    }
    return element.textContent || ''
  }

  return Array.from(template.content.childNodes).map((node, index) => nodeFromDom(node, `${keyPrefix}-${index}`))
}
