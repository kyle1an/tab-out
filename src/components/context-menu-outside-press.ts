import type { ContextMenuRootChangeEventDetails } from '@base-ui/react/context-menu'
import { pointWithinRect } from './pointer-position'

export type ContextMenuChangeEventDetails = ContextMenuRootChangeEventDetails

// A context-menu wrapper can rerender its trigger while the menu is open, so
// Base UI's opening trigger may be detached by the close callback. Consumers
// provide their current live interaction surface for the coordinate check.
export function isOutsidePressInsideElement(
  details: ContextMenuChangeEventDetails,
  element: Element | null | undefined,
): boolean {
  if (details.reason !== 'outside-press') return false
  const { event } = details
  if (!element?.isConnected || 'touches' in event) return false
  if ('pointerType' in event && event.pointerType === 'touch') return false
  const rect = element.getBoundingClientRect()
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    pointWithinRect({ x: event.clientX, y: event.clientY }, rect)
  )
}
