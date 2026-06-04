import * as React from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'

import { cn } from '@/lib/utils'
import { menuItemClassName, menuPopupClassName } from './menu-styles'

const Menu = MenuPrimitive.Root
const MenuTrigger = MenuPrimitive.Trigger

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI menu primitive family is intentionally colocated in one file.
function MenuContent({
  align = 'end',
  alignOffset = 0,
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  // No Backdrop here (unlike ui/context-menu): Base UI's Menu dismisses on outside
  // press natively — a backdrop is only needed to swallow the right-click event.
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-70"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(menuPopupClassName, className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI menu primitive family is intentionally colocated in one file.
function MenuItem({ className, children, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(menuItemClassName, className)}
      {...props}
    >
      {children}
    </MenuPrimitive.Item>
  )
}

export { Menu, MenuContent, MenuItem, MenuTrigger }
