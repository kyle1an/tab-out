import * as React from 'react'
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'

import { cn } from '@/lib/utils'
import { menuItemClassName, menuPopupClassName } from './menu-styles'
import { clearActiveContextMenu, setActiveContextMenu } from './context-menu-registry'

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

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

// react-doctor-disable-next-line react-doctor/no-multi-comp -- shadcn context-menu primitive family is intentionally colocated in one file.
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
        className="fixed inset-0 z-60 cursor-default bg-transparent"
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
        className="isolate z-70"
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            menuPopupClassName,
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

// react-doctor-disable-next-line react-doctor/no-multi-comp -- shadcn context-menu primitive family is intentionally colocated in one file.
function ContextMenuItem({
  className,
  children,
  ...props
}: ContextMenuPrimitive.Item.Props) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        menuItemClassName,
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
  ContextMenuTrigger
}
