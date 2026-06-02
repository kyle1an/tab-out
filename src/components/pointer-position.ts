// Tracks the latest pointer position globally (one listener for the whole app) so
// transient overlays can ask "is the pointer over this element right now?" at a moment
// when the element is occluded (e.g. behind a context-menu backdrop) and hit-testing
// via :hover / elementFromPoint would not see it.

const lastPointerPosition = { x: -1, y: -1 }
let tracking = false

export function startPointerPositionTracking(): void {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener(
    'pointermove',
    (event) => {
      lastPointerPosition.x = event.clientX
      lastPointerPosition.y = event.clientY
    },
    { capture: true, passive: true }
  )
}

interface RectBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export function pointWithinRect(point: { x: number; y: number }, rect: RectBounds | null | undefined): boolean {
  if (!rect) return false
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

export function pointerIsOverElement(element: HTMLElement | null | undefined): boolean {
  return pointWithinRect(lastPointerPosition, element?.getBoundingClientRect())
}
