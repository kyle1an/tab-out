import { useRef, useState } from 'react'
import { closeAllSuspendedTabs } from '../extension/tab-actions'
import { Menu, MenuContent, MenuItem, MenuTrigger } from './ui/menu'

interface HeaderTabActionsMenuProps {
  ready: boolean
}

export function HeaderTabActionsMenu({ ready }: HeaderTabActionsMenuProps) {
  const closeAllSuspendedPendingRef = useRef(false)
  const [closeAllSuspendedPending, setCloseAllSuspendedPending] = useState(false)

  function onCloseSuspended() {
    if (closeAllSuspendedPendingRef.current) return
    closeAllSuspendedPendingRef.current = true
    setCloseAllSuspendedPending(true)
    return closeAllSuspendedTabs()
      .then(() => undefined)
      .finally(() => {
        closeAllSuspendedPendingRef.current = false
        setCloseAllSuspendedPending(false)
      })
  }

  return (
    <div data-tabout="tab-actions" className="inline-flex">
      <Menu>
        <MenuTrigger
          data-tabout-part="menu-trigger"
          className="header-tab-actions-menu-trigger grid size-(--header-control-height) shrink-0 cursor-pointer place-items-center rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card p-0 text-muted-foreground transition-[color,border-color,background-color] duration-200 outline-none [corner-shape:squircle] hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:border-foreground data-popup-open:bg-[rgba(82,82,82,0.08)] data-popup-open:text-foreground"
          aria-label="Tab actions"
          disabled={!ready}
        >
          <span className="icon-[lucide--ellipsis] size-4" aria-hidden="true" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem
            data-tabout-part="close-suspended-button"
            disabled={closeAllSuspendedPending}
            label="Close all suspended tabs"
            onClick={onCloseSuspended}
          >
            <span className="icon-[lucide--circle-x] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">Close all suspended tabs</span>
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
