/* ================================================================
   Working Set move adapter — configures the shared move-animation
   module for row moves inside the working-set grid: root-relative
   coordinates (positions stay stable while the panel scrolls), one
   position per layout key, and the settle phase that keeps the
   toggle's interaction chrome suppressed while it lands (the
   suppression CSS in extension/base.css keys off the marker classes
   written here).
   ================================================================ */

import { createMoveAnimator } from './move-animation.js'
import type { MovePosition, MovePositionMap } from './move-animation.js'

export type WorkingSetItemPosition = MovePosition
export type WorkingSetItemPositionMap = Map<string, WorkingSetItemPosition>

const WORKING_SET_ITEM_MOVE_MS = 220
const WORKING_SET_ITEM_SETTLE_MS = 80
const WORKING_SET_LAYOUT_SELECTOR = '.working-set-layout-item[data-working-set-layout-key]'
const WORKING_SET_TOGGLE_SELECTOR = '.working-set-toggle'
const WORKING_SET_ITEM_SETTLING_CLASS = 'working-set-layout-settling'
const activeWorkingSetItemSettles = new WeakMap<HTMLElement, number>()

function settleWorkingSetItemMove(item: HTMLElement) {
  if (!item.matches(WORKING_SET_TOGGLE_SELECTOR)) return

  const activeSettle = activeWorkingSetItemSettles.get(item)
  if (activeSettle) clearTimeout(activeSettle)

  item.classList.add(WORKING_SET_ITEM_SETTLING_CLASS)
  activeWorkingSetItemSettles.set(item, Number(setTimeout(() => {
    activeWorkingSetItemSettles.delete(item)
    item.classList.remove(WORKING_SET_ITEM_SETTLING_CLASS)
  }, WORKING_SET_ITEM_SETTLE_MS)))
}

function clearWorkingSetItemSettle(item: HTMLElement) {
  const activeSettle = activeWorkingSetItemSettles.get(item)
  if (activeSettle) {
    clearTimeout(activeSettle)
    activeWorkingSetItemSettles.delete(item)
  }
  item.classList.remove(WORKING_SET_ITEM_SETTLING_CLASS)
}

const workingSetItemAnimator = createMoveAnimator({
  itemSelector: WORKING_SET_LAYOUT_SELECTOR,
  keyOf: (item) => item.dataset.workingSetLayoutKey || '',
  duration: WORKING_SET_ITEM_MOVE_MS,
  movingClass: 'working-set-layout-moving',
  activeClass: 'working-set-layout-moving-active',
  coordinateSpace: 'root',
  moveZIndex: '2',
  afterCleanup: (item) => settleWorkingSetItemMove(item),
  onCancel: (item) => clearWorkingSetItemSettle(item)
})

export function snapshotWorkingSetItemPositions(grid: HTMLElement | null): WorkingSetItemPositionMap {
  const positions: WorkingSetItemPositionMap = new Map()
  if (!grid) return positions

  for (const [key, list] of workingSetItemAnimator.snapshot([grid])) {
    const position = list[0]
    if (position) positions.set(key, position)
  }
  return positions
}

export function cancelWorkingSetItemMoves(grid: HTMLElement | null) {
  if (!grid) return
  workingSetItemAnimator.cancel([grid])
}

export function animateWorkingSetItemMoves(grid: HTMLElement | null, previousPositions: WorkingSetItemPositionMap | null) {
  if (!grid || !previousPositions || previousPositions.size === 0) return

  const previous: MovePositionMap = new Map()
  for (const [key, position] of previousPositions) previous.set(key, [position])
  workingSetItemAnimator.animate([grid], previous)
}
