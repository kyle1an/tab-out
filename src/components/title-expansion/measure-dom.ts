/* ================================================================
   Expansion measure element — Title Expansion internals. A detached,
   invisible clone box appended to the body so the width search can
   probe candidate widths without touching the live layout. The box
   inherits the source element's font metrics and neutralizes clamp
   masks and hyphenation so probes measure pure line breaking.

   Surfaces pass their own class tokens (fingerprinted by tests and
   used by their fit predicates) and their own markup: chips hydrate
   cloned marker fragments, history rows serialize captured lines.
   ================================================================ */

export type ExpansionMeasureElementOptions = {
  className: string
  markup: string
}

export function createExpansionMeasureElement(sourceEl: HTMLElement, { className, markup }: ExpansionMeasureElementOptions): HTMLElement | null {
  const ownerDocument = sourceEl.ownerDocument
  if (!ownerDocument.body) return null

  const ownerWindow = ownerDocument.defaultView
  if (!ownerWindow) return null

  const styles = ownerWindow.getComputedStyle(sourceEl)
  const measureEl = ownerDocument.createElement('span')
  measureEl.className = className
  measureEl.setAttribute('aria-hidden', 'true')
  Object.assign(measureEl.style, {
    display: 'block',
    font: styles.font,
    left: '0',
    letterSpacing: styles.letterSpacing,
    lineHeight: styles.lineHeight,
    maxHeight: 'none',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'normal',
    width: 'max-content',
  })
  measureEl.style.setProperty('hyphenate-character', '')
  measureEl.style.setProperty('mask-image', 'none')
  measureEl.style.setProperty('overflow-wrap', 'break-word')
  measureEl.innerHTML = markup
  ownerDocument.body.append(measureEl)
  return measureEl
}
