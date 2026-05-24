import * as React from 'react'
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'

import { cn } from '@/lib/utils'

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

type ActiveContextMenu = {
  id: string
  close: () => void
}

let activeContextMenuId: string | null = null
let activeContextMenuClose: (() => void) | null = null

function setActiveContextMenu(nextMenu: ActiveContextMenu | null) {
  if (nextMenu && activeContextMenuId && activeContextMenuId !== nextMenu.id) {
    activeContextMenuClose?.()
  }

  activeContextMenuId = nextMenu?.id ?? null
  activeContextMenuClose = nextMenu?.close ?? null
}

function clearActiveContextMenu(id: string) {
  if (activeContextMenuId === id) setActiveContextMenu(null)
}

function isContextMenuOpen() {
  return activeContextMenuId !== null
}

function stopBackdropEvent(event: React.SyntheticEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function ContextMenu({
  onOpenChange,
  ...props
}: ContextMenuPrimitive.Root.Props) {
  const id = React.useId()
  const actionsRef = React.useRef<ContextMenuPrimitive.Root.Actions | null>(null)

  function handleOpenChange(open: boolean, eventDetails: ContextMenuPrimitive.Root.ChangeEventDetails) {
    if (open) {
      setActiveContextMenu({
        id,
        close: () => actionsRef.current?.close()
      })
    } else {
      clearActiveContextMenu(id)
    }
    onOpenChange?.(open, eventDetails)
  }

  React.useEffect(() => () => clearActiveContextMenu(id), [id])

  return (
    <ContextMenuPrimitive.Root
      {...props}
      actionsRef={actionsRef}
      onOpenChange={handleOpenChange}
    />
  )
}

function ContextMenuContent({
  align = 'start',
  alignOffset = 0,
  className,
  children,
  side,
  sideOffset = 4,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Backdrop
        data-slot="context-menu-backdrop"
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
        onPointerDown={stopBackdropEvent}
        onPointerUp={stopBackdropEvent}
        onClick={stopBackdropEvent}
        onContextMenu={stopBackdropEvent}
      />
      <ContextMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-[70]"
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            'relative isolate z-[70] min-w-40 rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none [corner-shape:squircle]',
            className
          )}
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  children,
  ...props
}: ContextMenuPrimitive.Item.Props) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        'relative flex min-h-7 min-w-36 cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-tight text-tab-ink outline-none select-none [corner-shape:squircle] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className
      )}
      {...props}
    >
      {children}
    </ContextMenuPrimitive.Item>
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  isContextMenuOpen
}
