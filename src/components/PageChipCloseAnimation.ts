import type { LayoutChangeHandler } from './types'

export const PAGE_CHIP_CLOSE_ANIMATION_MS = 200
const PAGE_CHIP_CLOSE_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

type PageChipCloseAnimationStyle = Partial<Pick<CSSStyleDeclaration, 'height' | 'left' | 'margin' | 'maxHeight' | 'opacity' | 'overflow' | 'paddingBottom' | 'paddingTop' | 'pointerEvents' | 'position' | 'top' | 'transform' | 'transformOrigin' | 'transition' | 'width' | 'zIndex'>>
type PageChipCloseAnimationGhost = {
  classList: Pick<DOMTokenList, 'add'>
  style: PageChipCloseAnimationStyle
  getBoundingClientRect?: () => unknown
  setAttribute?: (name: string, value: string) => void
  remove?: () => void
}
type PageChipCloseAnimationElement = {
  classList: Pick<DOMTokenList, 'add'> & Partial<Pick<DOMTokenList, 'remove'>>
  style: PageChipCloseAnimationStyle
  getBoundingClientRect: () => Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>
  cloneNode?: (deep?: boolean) => PageChipCloseAnimationGhost
  ownerDocument?: {
    body?: {
      appendChild: (node: PageChipCloseAnimationGhost) => unknown
    }
  }
}
type PageChipCloseAnimationScheduler = (handler: () => void, delay: number) => unknown

function isPageChipCloseAnimationElement(value: unknown): value is PageChipCloseAnimationElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PageChipCloseAnimationElement>
  return (
    !!candidate.classList &&
    typeof candidate.classList.add === 'function' &&
    !!candidate.style &&
    typeof candidate.getBoundingClientRect === 'function'
  )
}

function shouldReduceCloseMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function pageChipCloseAnimationWaitMs() {
  return shouldReduceCloseMotion() ? 0 : PAGE_CHIP_CLOSE_ANIMATION_MS
}

function schedulePageChipCloseAnimationCleanup(handler: () => void, delay: number) {
  return window.setTimeout(handler, delay)
}

function createClosingGhost(chipEl: PageChipCloseAnimationElement, rect: Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>, duration: number, scheduleCleanup: PageChipCloseAnimationScheduler) {
  const ghost = chipEl.cloneNode?.(true)
  const body = chipEl.ownerDocument?.body
  if (!ghost || !body) return

  ghost.classList.add('page-chip-closing-ghost')
  ghost.setAttribute?.('aria-hidden', 'true')
  ghost.style.position = 'fixed'
  ghost.style.left = `${rect.left}px`
  ghost.style.top = `${rect.top}px`
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
  ghost.style.margin = '0'
  ghost.style.maxHeight = `${rect.height}px`
  ghost.style.overflow = 'hidden'
  ghost.style.pointerEvents = 'none'
  ghost.style.zIndex = '50'
  ghost.style.opacity = '1'
  ghost.style.transform = 'scale(1)'
  ghost.style.transformOrigin = 'top left'
  ghost.style.transition = duration > 0
    ? [
        `opacity ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`,
        `transform ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`
      ].join(', ')
    : 'none'

  body.appendChild(ghost)
  ghost.getBoundingClientRect?.()
  ghost.style.opacity = '0'
  ghost.style.transform = 'scale(0.96)'
  scheduleCleanup(() => ghost.remove?.(), duration + 80)
}

export function startPageChipCloseAnimation(chipEl: unknown, onLayoutChange: LayoutChangeHandler | null = null, scheduleCleanup: PageChipCloseAnimationScheduler = schedulePageChipCloseAnimationCleanup): boolean {
  if (!isPageChipCloseAnimationElement(chipEl)) return false

  const duration = shouldReduceCloseMotion() ? 0 : PAGE_CHIP_CLOSE_ANIMATION_MS
  const rect = chipEl.getBoundingClientRect()
  const height = Math.max(0, Math.ceil(rect.height))
  createClosingGhost(chipEl, rect, duration, scheduleCleanup)
  chipEl.style.maxHeight = `${height}px`
  chipEl.style.overflow = 'hidden'
  chipEl.style.opacity = '0'
  chipEl.style.transition = duration > 0
    ? [
        `max-height ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`,
        `padding ${duration}ms ${PAGE_CHIP_CLOSE_EASING}`
      ].join(', ')
    : 'none'

  chipEl.getBoundingClientRect()
  chipEl.classList.add('closing')
  chipEl.style.maxHeight = '0px'
  chipEl.style.paddingTop = '0px'
  chipEl.style.paddingBottom = '0px'
  onLayoutChange?.({ animate: duration > 0 })
  return true
}

export async function waitForPageChipCloseAnimation() {
  const duration = pageChipCloseAnimationWaitMs()
  if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration))
}
