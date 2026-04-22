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

import { useEffect, useRef } from './vendor/preact-hooks.mjs'

const MIN_COL_WIDTH = 260
const GAP = 10

export function packMissionsMasonry(containers, { unpin = false, lastColCounts = null } = {}) {
  const targets = Array.isArray(containers) ? containers : [containers]
  for (const container of targets) {
    packContainer(container, unpin, lastColCounts)
  }
}

function packContainer(container, unpin, lastColCounts) {
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
  // Inter-card gap tightened 12→10 — chips already have their own
  // vertical rhythm, so 10px reads as deliberate card separation
  // without the extra breathing room the larger gap added.
  const colCount = Math.max(1, Math.floor((containerWidth + GAP) / (MIN_COL_WIDTH + GAP)))
  const colWidth = (containerWidth - GAP * (colCount - 1)) / colCount

  const prevColCount = lastColCounts?.get(container)
  if (unpin || prevColCount !== colCount) {
    cards.forEach((c) => delete c.dataset.masonryCol)
    lastColCounts?.set(container, colCount)
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
    card.style.left = `${col * (colWidth + GAP)}px`
    card.style.top = `${colHeights[col]}px`
    colHeights[col] += card.getBoundingClientRect().height + GAP
  })

  container.style.height = `${Math.max(...colHeights) - GAP}px`
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

export function useMissionsMasonry(primaryRef, secondaryRef) {
  const lastColCountsRef = useRef(new WeakMap())
  const rafIdRef = useRef(0)
  const observerRef = useRef(null)

  function packMissionsMasonryNow({ unpin = false } = {}) {
    packMissionsMasonry([primaryRef.current, secondaryRef.current], {
      unpin,
      lastColCounts: lastColCountsRef.current
    })
  }

  function scheduleMissionsMasonry({ unpin = false } = {}) {
    cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = requestAnimationFrame(() => packMissionsMasonryNow({ unpin }))
  }

  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return
    let observer = observerRef.current
    if (!observer) {
      observer = new ResizeObserver(() => scheduleMissionsMasonry())
      observerRef.current = observer
    }
    observer.disconnect()
    ;[primaryRef.current, secondaryRef.current].forEach((container) => {
      if (container) observer.observe(container)
    })
    return () => observer.disconnect()
  }, [primaryRef.current, secondaryRef.current])

  useEffect(
    () => () => {
      cancelAnimationFrame(rafIdRef.current)
      observerRef.current?.disconnect()
    },
    []
  )

  return { packMissionsMasonryNow, scheduleMissionsMasonry }
}
