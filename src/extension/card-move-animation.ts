export type MissionContainer = HTMLDivElement | null
export type CardPosition = { left: number; top: number }
export type CardPositionMap = Map<string, CardPosition[]>
export type CardMoveAnimationOptions = {
  allowBleed?: boolean
}

type CardMoveAnimation = {
  frameId: number
  timeoutId: number
  onTransitionEnd: (e: TransitionEvent) => void
}

const CARD_MOVE_MS = 280
const CARD_MOVE_BLEED_CLASS = 'card-motion-bleed'
const activeCardMoveAnimations = new WeakMap<HTMLElement, CardMoveAnimation>()
const activeCardMoveBleedTimeouts = new WeakMap<HTMLElement, number>()

function shouldReduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function snapshotDomainCardRects(containers: MissionContainer[]): CardPositionMap {
  const rects: CardPositionMap = new Map()
  if (shouldReduceMotion()) return rects

  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll<HTMLElement>('.domain-block:not(.closing)').forEach((block) => {
      const id = block.dataset.domainId
      if (!id) return
      const rect = block.getBoundingClientRect()
      let positions = rects.get(id)
      if (!positions) {
        positions = []
        rects.set(id, positions)
      }
      positions.push({
        left: rect.left,
        top: rect.top
      })
    })
  })

  return rects
}

function cancelDomainCardMove(block: HTMLElement) {
  const active = activeCardMoveAnimations.get(block)
  if (active) {
    cancelAnimationFrame(active.frameId)
    clearTimeout(active.timeoutId)
    block.removeEventListener('transitionend', active.onTransitionEnd)
    activeCardMoveAnimations.delete(block)
  }

  block.classList.remove('layout-moving', 'layout-moving-active')
  block.style.transform = ''
}

export function cancelDomainCardMoves(containers: MissionContainer[]) {
  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll<HTMLElement>('.domain-block.layout-moving').forEach(cancelDomainCardMove)
  })
}

export function prepareDomainCardMoveAnimation(containers: MissionContainer[]): CardPositionMap {
  const previousRects = snapshotDomainCardRects(containers)
  cancelDomainCardMoves(containers)
  return previousRects
}

function takeClosestPreviousRect(previousRects: CardPositionMap, id: string | undefined, nextRect: DOMRect): CardPosition | null {
  const candidates = id ? previousRects.get(id) : null
  if (!candidates || candidates.length === 0) return null

  let closestIndex = 0
  let closestDistance = Infinity
  candidates.forEach((candidate, index) => {
    const dx = candidate.left - nextRect.left
    const dy = candidate.top - nextRect.top
    const distance = dx * dx + dy * dy
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })

  const [closest] = candidates.splice(closestIndex, 1)
  if (!closest) return null
  if (candidates.length === 0 && id) previousRects.delete(id)
  return closest
}

function enableCardMoveBleed(containers: MissionContainer[]) {
  const scrollRegions = new Set<HTMLElement>()
  containers.forEach((container) => {
    const scrollRegion = container?.closest<HTMLElement>('.scroll-region')
    if (scrollRegion) scrollRegions.add(scrollRegion)
  })

  scrollRegions.forEach((scrollRegion) => {
    const activeTimeout = activeCardMoveBleedTimeouts.get(scrollRegion)
    if (activeTimeout) clearTimeout(activeTimeout)

    scrollRegion.classList.add(CARD_MOVE_BLEED_CLASS)
    activeCardMoveBleedTimeouts.set(scrollRegion, window.setTimeout(() => {
      activeCardMoveBleedTimeouts.delete(scrollRegion)
      scrollRegion.classList.remove(CARD_MOVE_BLEED_CLASS)
    }, CARD_MOVE_MS + 100))
  })
}

export function animateDomainCardMoves(containers: MissionContainer[], previousRects: CardPositionMap | null, { allowBleed = true }: CardMoveAnimationOptions = {}) {
  if (!previousRects || previousRects.size === 0 || shouldReduceMotion()) return

  const moving: HTMLElement[] = []
  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll<HTMLElement>('.domain-block:not(.closing)').forEach((block) => {
      const id = block.dataset.domainId

      cancelDomainCardMove(block)
      const next = block.getBoundingClientRect()
      const previous = takeClosestPreviousRect(previousRects, id, next)
      if (!previous) return

      const dx = previous.left - next.left
      const dy = previous.top - next.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

      block.classList.add('layout-moving')
      block.style.transform = `translate(${dx}px, ${dy}px)`
      moving.push(block)
    })
  })

  if (moving.length === 0) return

  if (allowBleed) enableCardMoveBleed(containers)
  document.body.getBoundingClientRect()

  moving.forEach((block) => {
    function cleanup() {
      if (activeCardMoveAnimations.get(block) !== active) return
      activeCardMoveAnimations.delete(block)
      block.removeEventListener('transitionend', onTransitionEnd)
      block.classList.remove('layout-moving', 'layout-moving-active')
      block.style.transform = ''
    }
    function onTransitionEnd(e: TransitionEvent) {
      if (e.target === block && e.propertyName === 'transform') cleanup()
    }
    const active = {
      frameId: 0,
      timeoutId: 0,
      onTransitionEnd
    }

    block.addEventListener('transitionend', onTransitionEnd)
    active.frameId = requestAnimationFrame(() => {
      if (activeCardMoveAnimations.get(block) !== active) return
      block.classList.add('layout-moving-active')
      block.style.transform = 'translate(0, 0)'
    })
    active.timeoutId = window.setTimeout(cleanup, CARD_MOVE_MS + 80)
    activeCardMoveAnimations.set(block, active)
  })
}
