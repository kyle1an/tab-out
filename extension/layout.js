/* ================================================================
   Masonry layout for the two missions grids

   Pinterest-style: each .domain-block is absolutely positioned in the
   shortest column on first sight, then PINNED to that column for
   subsequent re-packs. Growing one block only shifts the blocks below
   it in the same column — others hold position.

   The block is the masonry unit (not the inner .mission-card) because
   the header moved out of the card in the "title as section label"
   redesign: title + pill + badges + actions live in .domain-header,
   and the rounded chip container is inside a sibling .mission-card.
   Masonry needs to measure both as one unit.

   There are two parallel grids — `#openTabsMissions` (primary: cards
   with matching chips) and `#openTabsMissionsUnmatched` (secondary:
   same cards rendered again to surface their non-matching chips
   under the "Other tabs" divider). Both are packed with the same
   algorithm; the secondary grid is skipped when its wrapper is
   display:none (filter inactive or nothing unmatched).

   Layout state is stored on each block in `dataset.masonryCol`.
   Column count changes (window resize crossing a breakpoint) reset
   all assignments. The `unpin` flag also resets, used by the filter
   when the visible block set changes.
   ================================================================ */

const CONTAINER_IDS = ['openTabsMissions', 'openTabsMissionsUnmatched']

let lastColCount = null
let resizeTimer = null

export function packMissionsMasonry({ unpin = false } = {}) {
  for (const id of CONTAINER_IDS) {
    packContainer(id, unpin)
  }
}

function packContainer(containerId, unpin) {
  const container = document.getElementById(containerId)
  if (!container) return

  const containerWidth = container.clientWidth
  if (containerWidth === 0) return // section hidden — nothing to layout

  const cards = Array.from(container.querySelectorAll('.domain-block:not(.closing)')).filter((c) => getComputedStyle(c).display !== 'none')
  if (cards.length === 0) {
    container.style.height = ''
    return
  }

  // 260 (was 280) picks up one extra column at common viewport widths
  // (1280, 1440, 1600) without making cards feel cramped — chip text
  // already truncates with an ellipsis, so a slightly narrower card
  // reads the same as a wider one but packs more per row.
  const minColWidth = 260
  // Inter-card gap tightened 12→10 — chips already have their own
  // vertical rhythm, so 10px reads as deliberate card separation
  // without the extra breathing room the larger gap added.
  const gap = 10
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
  const colWidth = (containerWidth - gap * (colCount - 1)) / colCount

  if (unpin || lastColCount !== colCount) {
    cards.forEach((c) => delete c.dataset.masonryCol)
    lastColCount = colCount
  }

  cards.forEach((card) => {
    card.style.position = 'absolute'
    card.style.width = `${colWidth}px`
  })

  const colHeights = new Array(colCount).fill(0)
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

  container.style.height = `${Math.max(...colHeights) - gap}px`
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => packMissionsMasonry(), 100)
})
