/* ================================================================
   Domain Card move adapter — configures the shared move-animation
   module for masonry card flights: viewport coordinates (cards fly
   across mission containers and over the history pane), duplicate
   Domain Card ids resolved by closest-match, and the temporary
   scroll-region bleed so mid-flight cards aren't clipped.
   ================================================================ */

import { createMoveAnimator } from './move-animation.js'
import type { MovePositionMap } from './move-animation.js'

export type MissionContainer = HTMLDivElement | null
export type CardPosition = { left: number; top: number }
export type CardPositionMap = MovePositionMap
export type CardMoveAnimationOptions = {
  allowBleed?: boolean
}

const CARD_MOVE_MS = 280
const CARD_MOVE_BLEED_CLASS = 'card-motion-bleed'
const activeCardMoveBleedTimeouts = new WeakMap<HTMLElement, number>()

const cardMoveAnimator = createMoveAnimator({
  itemSelector: '.domain-block:not(.closing)',
  keyOf: (block) => block.dataset.domainId || '',
  duration: CARD_MOVE_MS,
  movingClass: 'layout-moving',
  activeClass: 'layout-moving-active',
  coordinateSpace: 'viewport'
})

function enableCardMoveBleed(containers: ReadonlyArray<HTMLElement | null>) {
  const scrollRegions = new Set<HTMLElement>()
  containers.forEach((container) => {
    const scrollRegion = container?.closest<HTMLElement>('.scroll-region')
    if (scrollRegion) scrollRegions.add(scrollRegion)
  })

  scrollRegions.forEach((scrollRegion) => {
    const activeTimeout = activeCardMoveBleedTimeouts.get(scrollRegion)
    if (activeTimeout) clearTimeout(activeTimeout)

    scrollRegion.classList.add(CARD_MOVE_BLEED_CLASS)
    activeCardMoveBleedTimeouts.set(scrollRegion, Number(setTimeout(() => {
      activeCardMoveBleedTimeouts.delete(scrollRegion)
      scrollRegion.classList.remove(CARD_MOVE_BLEED_CLASS)
    }, CARD_MOVE_MS + 100)))
  })
}

export function cancelDomainCardMoves(containers: MissionContainer[]) {
  cardMoveAnimator.cancel(containers)
}

export function hasActiveDomainCardMoves(containers: MissionContainer[]) {
  return containers.some((container) => !!container?.querySelector('.domain-block.layout-moving'))
}

export function prepareDomainCardMoveAnimation(containers: MissionContainer[]): CardPositionMap {
  const previousRects = cardMoveAnimator.snapshot(containers)
  cardMoveAnimator.cancel(containers)
  return previousRects
}

export function animateDomainCardMoves(containers: MissionContainer[], previousRects: CardPositionMap | null, { allowBleed = true }: CardMoveAnimationOptions = {}) {
  cardMoveAnimator.animate(containers, previousRects, {
    beforePlay: () => {
      if (allowBleed) enableCardMoveBleed(containers)
    }
  })
}
