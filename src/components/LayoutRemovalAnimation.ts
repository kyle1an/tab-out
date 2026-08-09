export const LAYOUT_REMOVAL_ANIMATION_MS = 160
export const REDUCED_LAYOUT_REMOVAL_ANIMATION_MS = 120
const DEFERRED_LAYOUT_REMOVAL_FALLBACK_MS = 1_000

const LAYOUT_REMOVAL_EASING = 'cubic-bezier(0.2, 0, 0, 1)'
const LAYOUT_REMOVAL_CLEANUP_GRACE_MS = 80

type LayoutRemovalStyle = Partial<Pick<
  CSSStyleDeclaration,
  | 'display'
  | 'height'
  | 'left'
  | 'margin'
  | 'opacity'
  | 'overflow'
  | 'pointerEvents'
  | 'position'
  | 'top'
  | 'transform'
  | 'transformOrigin'
  | 'transition'
  | 'width'
  | 'zIndex'
>>

type LayoutRemovalGhost = {
  classList: Pick<DOMTokenList, 'add'>
  style: LayoutRemovalStyle
  getBoundingClientRect?: () => unknown
  setAttribute?: (name: string, value: string) => void
  remove?: () => void
}

type LayoutRemovalElement = {
  classList: Pick<DOMTokenList, 'add'>
  isConnected?: boolean
  setAttribute?: (name: string, value: string) => void
  style: LayoutRemovalStyle
}

type LayoutRemovalSurface = LayoutRemovalElement & {
  cloneNode?: (deep?: boolean) => LayoutRemovalGhost
  getBoundingClientRect: () => Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>
  ownerDocument?: {
    body?: {
      appendChild: (node: LayoutRemovalGhost) => unknown
    }
  }
}

export type LayoutRemovalAnimationScheduler = (handler: () => void, delay: number) => unknown

export type LayoutRemovalAnimationOptions = {
  ghostClassName: string
  layoutElement?: unknown
  /** Keep the real layout slot reserved until the caller's next render removes it. */
  deferLayoutRemoval?: boolean
  onBeforeRemove?: () => void
  onAfterRemove?: () => void
  onDeferredLayoutRelease?: () => void
  scheduleCleanup?: LayoutRemovalAnimationScheduler
  scheduleDeferredRelease?: LayoutRemovalAnimationScheduler
}

function isLayoutRemovalElement(value: unknown): value is LayoutRemovalElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LayoutRemovalElement>
  return !!candidate.classList && typeof candidate.classList.add === 'function' && !!candidate.style
}

function isLayoutRemovalSurface(value: unknown): value is LayoutRemovalSurface {
  return isLayoutRemovalElement(value) &&
    typeof (value as Partial<LayoutRemovalSurface>).getBoundingClientRect === 'function'
}

function shouldReduceRemovalMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function scheduleLayoutRemovalCleanup(handler: () => void, delay: number) {
  return window.setTimeout(handler, delay)
}

export function startLayoutRemovalAnimation(
  surfaceValue: unknown,
  {
    ghostClassName,
    layoutElement: layoutElementValue,
    deferLayoutRemoval = false,
    onBeforeRemove,
    onAfterRemove,
    onDeferredLayoutRelease,
    scheduleCleanup = scheduleLayoutRemovalCleanup,
    scheduleDeferredRelease = scheduleLayoutRemovalCleanup,
  }: LayoutRemovalAnimationOptions,
): boolean {
  if (!isLayoutRemovalSurface(surfaceValue)) return false

  const surface = surfaceValue
  const layoutElement = isLayoutRemovalElement(layoutElementValue) ? layoutElementValue : surface
  const reducedMotion = shouldReduceRemovalMotion()
  const duration = reducedMotion ? REDUCED_LAYOUT_REMOVAL_ANIMATION_MS : LAYOUT_REMOVAL_ANIMATION_MS
  const rect = surface.getBoundingClientRect()
  const ghost = surface.cloneNode?.(true)
  const body = surface.ownerDocument?.body

  onBeforeRemove?.()

  if (ghost && body) {
    ghost.classList.add(ghostClassName)
    ghost.setAttribute?.('aria-hidden', 'true')
    ghost.setAttribute?.('inert', '')
    ghost.style.position = 'fixed'
    ghost.style.left = `${rect.left}px`
    ghost.style.top = `${rect.top}px`
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    ghost.style.margin = '0'
    ghost.style.overflow = 'hidden'
    ghost.style.pointerEvents = 'none'
    ghost.style.zIndex = '50'
    ghost.style.opacity = '1'
    ghost.style.transform = 'scale(1)'
    ghost.style.transformOrigin = 'top left'
    ghost.style.transition = reducedMotion
      ? `opacity ${duration}ms ${LAYOUT_REMOVAL_EASING}`
      : [
          `opacity ${duration}ms ${LAYOUT_REMOVAL_EASING}`,
          `transform ${duration}ms ${LAYOUT_REMOVAL_EASING}`,
        ].join(', ')

    body.appendChild(ghost)
    ghost.getBoundingClientRect?.()
    ghost.style.opacity = '0'
    ghost.style.transform = reducedMotion ? 'scale(1)' : 'scale(0.96)'
    scheduleCleanup(() => ghost.remove?.(), duration + LAYOUT_REMOVAL_CLEANUP_GRACE_MS)
  }

  surface.classList.add('closing')
  if (layoutElement !== surface) layoutElement.classList.add('closing')
  surface.setAttribute?.('inert', '')
  layoutElement.setAttribute?.('inert', '')
  if (deferLayoutRemoval) {
    scheduleDeferredRelease(() => {
      if (layoutElement.isConnected === false) return
      layoutElement.style.display = 'none'
      onDeferredLayoutRelease?.()
    }, DEFERRED_LAYOUT_REMOVAL_FALLBACK_MS)
  } else {
    layoutElement.style.display = 'none'
  }
  onAfterRemove?.()
  return true
}
