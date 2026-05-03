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

   The primary grid can be followed by filter-only companion grids
   such as bookmark matches and the secondary "Other tabs" grid. All
   are packed with the same algorithm; hidden/empty grids are skipped.

   Layout state is stored on each block in `dataset.masonryCol`.
   Column count changes (window resize crossing a breakpoint) reset
   all assignments. The `unpin` flag also resets, used by the filter
   when the visible block set changes.
   ================================================================ */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

const MIN_COL_WIDTH = 260
const IDEAL_COL_WIDTH = 304
const GAP = 10

function isMasonryHookOptions(value) {
  return !!value && (typeof value.onBeforePack === 'function' || typeof value.onAfterPack === 'function')
}

function readCssPx(style, name, fallback) {
  const value = parseFloat(style.getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function masonryOptionsFor(container) {
  const style = getComputedStyle(container)
  return {
    minColWidth: readCssPx(style, '--masonry-min-col-width', MIN_COL_WIDTH),
    idealColWidth: readCssPx(style, '--masonry-ideal-col-width', IDEAL_COL_WIDTH),
    gap: readCssPx(style, '--masonry-gap', GAP)
  }
}

export function chooseMasonryLayout(containerWidth, { minColWidth = MIN_COL_WIDTH, idealColWidth = IDEAL_COL_WIDTH, gap = GAP } = {}) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { colCount: 1, colWidth: 0 }
  }

  const maxColCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
  let best = null

  for (let colCount = 1; colCount <= maxColCount; colCount++) {
    const colWidth = (containerWidth - gap * (colCount - 1)) / colCount
    if (colWidth < minColWidth && colCount > 1) continue

    const score = Math.abs(colWidth - idealColWidth)
    if (!best || score < best.score || (score === best.score && colCount > best.colCount)) {
      best = { colCount, colWidth, score }
    }
  }

  return best ? { colCount: best.colCount, colWidth: best.colWidth } : { colCount: 1, colWidth: containerWidth }
}

export function shouldAnimateMasonryResize(containerWidth, previousColCount, options = {}) {
  if (!Number.isInteger(previousColCount)) return false
  return chooseMasonryLayout(containerWidth, options).colCount !== previousColCount
}

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

  // Rather than adding a new column the instant it barely fits, pick
  // the column count whose resulting card width lands closest to the
  // comfort target. That keeps resize drag feeling less jumpy: cards
  // don't collapse to the minimum width at every threshold.
  const options = masonryOptionsFor(container)
  const { colCount, colWidth } = chooseMasonryLayout(containerWidth, options)

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
    card.style.left = `${col * (colWidth + options.gap)}px`
    card.style.top = `${colHeights[col]}px`
    colHeights[col] += card.getBoundingClientRect().height + options.gap
  })

  container.style.height = `${Math.max(...colHeights) - options.gap}px`
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

export function useMissionsMasonry(...args) {
  const options = isMasonryHookOptions(args[args.length - 1]) ? args.pop() : {}
  const containerRefs = args
  const { onBeforePack = null, onAfterPack = null } = options
  const lastColCountsRef = useRef(new WeakMap())
  const rafIdRef = useRef(0)
  const observerRef = useRef(null)
  const containerRefsRef = useRef(containerRefs)
  const optionsRef = useRef({ onBeforePack, onAfterPack })
  containerRefsRef.current = containerRefs
  optionsRef.current = { onBeforePack, onAfterPack }

  const currentContainers = useCallback(function currentContainers() {
    return containerRefsRef.current.map((ref) => ref.current)
  }, [])

  const packMissionsMasonryNow = useCallback(function packMissionsMasonryNow({ unpin = false, animate = false } = {}) {
    const containers = currentContainers()
    const { onBeforePack, onAfterPack } = optionsRef.current
    const animationState = animate && onBeforePack ? onBeforePack(containers) : null
    packMissionsMasonry(
      containers,
      {
        unpin,
        lastColCounts: lastColCountsRef.current
      }
    )
    if (animate && onAfterPack) onAfterPack(containers, animationState)
  }, [currentContainers])

  const shouldAnimateCurrentResize = useCallback(function shouldAnimateCurrentResize(containers) {
    return containers.some((container) => {
      if (!container || container.clientWidth === 0) return false
      const previousColCount = lastColCountsRef.current.get(container)
      return shouldAnimateMasonryResize(container.clientWidth, previousColCount, masonryOptionsFor(container))
    })
  }, [])

  const scheduleMissionsMasonry = useCallback(function scheduleMissionsMasonry({ unpin = false, animate = true } = {}) {
    cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = requestAnimationFrame(() => packMissionsMasonryNow({ unpin, animate }))
  }, [packMissionsMasonryNow])

  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'function') return
    let observer = observerRef.current
    if (!observer) {
      observer = new ResizeObserver(() => {
        const containers = currentContainers()
        scheduleMissionsMasonry({ animate: shouldAnimateCurrentResize(containers) })
      })
      observerRef.current = observer
    }
    observer.disconnect()
    containerRefs.forEach((ref) => {
      const container = ref.current
      if (container) observer.observe(container)
    })
    return () => observer.disconnect()
  })

  useEffect(
    () => () => {
      cancelAnimationFrame(rafIdRef.current)
      observerRef.current?.disconnect()
    },
    []
  )

  return { packMissionsMasonryNow, scheduleMissionsMasonry }
}
