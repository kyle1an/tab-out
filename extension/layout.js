/* ================================================================
   Masonry layout for #openTabsMissions

   Pinterest-style: each card is absolutely positioned in the shortest
   column on first sight, then PINNED to that column for subsequent
   re-packs. Growing one card only shifts the cards below it in the
   same column — others hold position.

   Layout state is stored on each card in `dataset.masonryCol`. Column
   count changes (window resize crossing a breakpoint) reset all
   assignments. The `unpin` flag also resets, used by the filter
   when the visible card set changes.
   ================================================================ */

let lastColCount = null
let resizeTimer = null

export function packMissionsMasonry({ unpin = false } = {}) {
  const container = document.getElementById('openTabsMissions')
  if (!container) return

  const containerWidth = container.clientWidth
  if (containerWidth === 0) return // section hidden — nothing to layout

  // Skip closing cards AND filter-hidden cards (display:none).
  const cards = Array.from(container.querySelectorAll('.mission-card:not(.closing)')).filter((c) => getComputedStyle(c).display !== 'none')
  if (cards.length === 0) {
    container.style.height = ''
    return
  }

  const minColWidth = 280
  const gap = 12
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
  const colWidth = (containerWidth - gap * (colCount - 1)) / colCount

  if (unpin || lastColCount !== colCount) {
    cards.forEach((c) => delete c.dataset.masonryCol)
    lastColCount = colCount
  }

  // Set width up front so each card's height settles before measuring.
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
  // Enable top/left transitions for subsequent packs (skipped on the very
  // first pack so cards don't visibly slide from (0,0) into position).
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => packMissionsMasonry(), 100)
})
