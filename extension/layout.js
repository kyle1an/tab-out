/* ================================================================
   Masonry layout for #openTabsMissions

   Pinterest-style: each card is absolutely positioned in the shortest
   column on first sight, then PINNED to that column for subsequent
   re-packs. Growing one card only shifts the cards below it in the
   same column — others hold position.

   When a filter is active, cards split into two groups:
     • Matched cards — packed first, starting at y=0
     • Unmatched cards (`.card-unmatched`) — packed below a divider
       with the label "Other tabs · N"
   Both groups share the same column grid (so cards in the same column
   stay vertically aligned across the divider).

   Layout state is stored on each card in `dataset.masonryCol`. Column
   count changes (window resize crossing a breakpoint) reset all
   assignments. The `unpin` flag also resets, used by the filter
   when the visible card set changes.
   ================================================================ */

const DIVIDER_TOP_GAP = 24
const DIVIDER_BOTTOM_GAP = 16

let lastColCount = null
let resizeTimer = null

export function packMissionsMasonry({ unpin = false } = {}) {
  const container = document.getElementById('openTabsMissions')
  if (!container) return

  const containerWidth = container.clientWidth
  if (containerWidth === 0) return // section hidden — nothing to layout

  // Skip closing cards AND filter-hidden cards (display:none).
  // Unmatched cards are NOT display:none — they're class-marked and
  // packed into the "Other tabs" group below matched cards.
  const allCards = Array.from(container.querySelectorAll('.mission-card:not(.closing)')).filter((c) => getComputedStyle(c).display !== 'none')
  if (allCards.length === 0) {
    container.style.height = ''
    removeDivider(container)
    return
  }

  const matchedCards = allCards.filter((c) => !c.classList.contains('card-unmatched'))
  const unmatchedCards = allCards.filter((c) => c.classList.contains('card-unmatched'))

  const minColWidth = 280
  const gap = 12
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
  const colWidth = (containerWidth - gap * (colCount - 1)) / colCount

  if (unpin || lastColCount !== colCount) {
    allCards.forEach((c) => delete c.dataset.masonryCol)
    lastColCount = colCount
  }

  // Width up front so each card's height settles before we measure it.
  allCards.forEach((card) => {
    card.style.position = 'absolute'
    card.style.width = `${colWidth}px`
  })

  // --- Pass 1: pack matched cards ---
  const colHeights = new Array(colCount).fill(0)
  packGroup(matchedCards, colHeights, colCount, colWidth, gap)
  const matchedMaxBottom = matchedCards.length > 0 ? Math.max(...colHeights) - gap : 0

  // --- Divider between the two groups ---
  let divider = null
  let unmatchedStartY = 0
  if (unmatchedCards.length > 0) {
    divider = ensureDivider(container, unmatchedCards.length)
    divider.style.position = 'absolute'
    divider.style.left = '0'
    divider.style.width = `${containerWidth}px`
    const dividerTop = matchedCards.length > 0 ? matchedMaxBottom + DIVIDER_TOP_GAP : 0
    divider.style.top = `${dividerTop}px`
    const dividerHeight = divider.getBoundingClientRect().height
    unmatchedStartY = dividerTop + dividerHeight + DIVIDER_BOTTOM_GAP
  } else {
    removeDivider(container)
  }

  // --- Pass 2: pack unmatched cards starting below the divider ---
  // Seed all columns at unmatchedStartY so the first unmatched card
  // picks col 0 (all equal), and subsequent cards naturally distribute
  // to the shortest remaining column.
  const unmatchedColHeights = new Array(colCount).fill(unmatchedStartY)
  packGroup(unmatchedCards, unmatchedColHeights, colCount, colWidth, gap)
  const unmatchedMaxBottom = unmatchedCards.length > 0 ? Math.max(...unmatchedColHeights) - gap : 0

  container.style.height = `${Math.max(matchedMaxBottom, unmatchedMaxBottom)}px`
  // Enable top/left transitions for subsequent packs (skipped on the very
  // first pack so cards don't visibly slide from (0,0) into position).
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

/** Standard masonry pack into a mutable colHeights array — each card
 *  goes to its pinned column (dataset.masonryCol) or the shortest
 *  available. */
function packGroup(cards, colHeights, colCount, colWidth, gap) {
  cards.forEach((card) => {
    let col
    const prev = parseInt(card.dataset.masonryCol, 10)
    if (Number.isInteger(prev) && prev >= 0 && prev < colCount) {
      col = prev
    } else {
      col = 0
      for (let i = 1; i < colCount; i++) {
        if (colHeights[i] < colHeights[col]) col = i
      }
      card.dataset.masonryCol = String(col)
    }
    card.style.left = `${col * (colWidth + gap)}px`
    card.style.top = `${colHeights[col]}px`
    colHeights[col] += card.getBoundingClientRect().height + gap
  })
}

/** Create the "Other tabs · N" divider on demand and update its count.
 *  Lives inside #openTabsMissions as an absolutely-positioned sibling
 *  to the cards; Preact will wipe it on the next vdom render, but
 *  packMissionsMasonry runs after every render so it gets recreated
 *  immediately. */
function ensureDivider(container, count) {
  let divider = container.querySelector('.missions-divider')
  if (!divider) {
    divider = document.createElement('div')
    divider.className = 'missions-divider'
    divider.innerHTML = /*html*/ `
      <span class="missions-divider-rule"></span>
      <span class="missions-divider-label"></span>
      <span class="missions-divider-rule"></span>
    `
    container.appendChild(divider)
  }
  const label = divider.querySelector('.missions-divider-label')
  if (label) label.textContent = `Other tabs · ${count}`
  return divider
}

function removeDivider(container) {
  const divider = container.querySelector('.missions-divider')
  if (divider) divider.remove()
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => packMissionsMasonry(), 100)
})
