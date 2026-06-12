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
