export type WorkingSetItemPosition = { left: number; top: number }
export type WorkingSetItemPositionMap = Map<string, WorkingSetItemPosition>

type WorkingSetItemMoveAnimation = {
  frameId: number
  timeoutId: number
  onTransitionEnd: (e: TransitionEvent) => void
}

const WORKING_SET_ITEM_MOVE_MS = 220
const WORKING_SET_LAYOUT_SELECTOR = '.working-set-layout-item[data-working-set-layout-key]'
const activeWorkingSetItemMoves = new WeakMap<HTMLElement, WorkingSetItemMoveAnimation>()

function shouldReduceMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function workingSetLayoutItems(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.querySelectorAll<HTMLElement>(WORKING_SET_LAYOUT_SELECTOR))
}

function workingSetLayoutKey(item: HTMLElement) {
  return item.dataset.workingSetLayoutKey || ''
}

function roundLayoutPosition(value: number) {
  return Math.round(value * 100) / 100
}

function workingSetLayoutPosition(item: HTMLElement, gridRect: DOMRect): WorkingSetItemPosition {
  const itemRect = item.getBoundingClientRect()
  return {
    left: roundLayoutPosition(itemRect.left - gridRect.left),
    top: roundLayoutPosition(itemRect.top - gridRect.top)
  }
}

export function snapshotWorkingSetItemPositions(grid: HTMLElement | null): WorkingSetItemPositionMap {
  const positions: WorkingSetItemPositionMap = new Map()
  if (!grid || shouldReduceMotion()) return positions

  const gridRect = grid.getBoundingClientRect()
  workingSetLayoutItems(grid).forEach((item) => {
    const key = workingSetLayoutKey(item)
    if (!key) return
    positions.set(key, workingSetLayoutPosition(item, gridRect))
  })

  return positions
}

function cancelWorkingSetItemMove(item: HTMLElement) {
  const active = activeWorkingSetItemMoves.get(item)
  if (active) {
    cancelAnimationFrame(active.frameId)
    clearTimeout(active.timeoutId)
    item.removeEventListener('transitionend', active.onTransitionEnd)
    activeWorkingSetItemMoves.delete(item)
  }

  item.classList.remove('working-set-layout-moving', 'working-set-layout-moving-active')
  item.style.transform = ''
  item.style.transition = ''
  item.style.willChange = ''
  item.style.zIndex = ''
}

export function cancelWorkingSetItemMoves(grid: HTMLElement | null) {
  if (!grid) return
  workingSetLayoutItems(grid).forEach(cancelWorkingSetItemMove)
}

export function animateWorkingSetItemMoves(grid: HTMLElement | null, previousPositions: WorkingSetItemPositionMap | null) {
  if (!grid || !previousPositions || previousPositions.size === 0 || shouldReduceMotion()) return

  const moving: HTMLElement[] = []
  const gridRect = grid.getBoundingClientRect()
  workingSetLayoutItems(grid).forEach((item) => {
    const previous = previousPositions.get(workingSetLayoutKey(item))
    if (!previous) return

    const current = workingSetLayoutPosition(item, gridRect)
    const dx = previous.left - current.left
    const dy = previous.top - current.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

    cancelWorkingSetItemMove(item)
    item.classList.add('working-set-layout-moving')
    item.style.transition = 'none'
    item.style.transform = `translate(${dx}px, ${dy}px)`
    item.style.willChange = 'transform'
    item.style.zIndex = '2'
    moving.push(item)
  })

  if (moving.length === 0) return

  grid.getBoundingClientRect()

  moving.forEach((item) => {
    function cleanup() {
      if (activeWorkingSetItemMoves.get(item) !== active) return
      activeWorkingSetItemMoves.delete(item)
      item.removeEventListener('transitionend', onTransitionEnd)
      item.classList.remove('working-set-layout-moving', 'working-set-layout-moving-active')
      item.style.transform = ''
      item.style.transition = ''
      item.style.willChange = ''
      item.style.zIndex = ''
    }
    function onTransitionEnd(e: TransitionEvent) {
      if (e.target === item && e.propertyName === 'transform') cleanup()
    }
    const active = {
      frameId: 0,
      timeoutId: 0,
      onTransitionEnd
    }

    item.addEventListener('transitionend', onTransitionEnd)
    active.frameId = requestAnimationFrame(() => {
      if (activeWorkingSetItemMoves.get(item) !== active) return
      item.classList.add('working-set-layout-moving-active')
      item.style.transition = `transform ${WORKING_SET_ITEM_MOVE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
      item.style.transform = 'translate(0, 0)'
    })
    active.timeoutId = window.setTimeout(cleanup, WORKING_SET_ITEM_MOVE_MS + 80)
    activeWorkingSetItemMoves.set(item, active)
  })
}
