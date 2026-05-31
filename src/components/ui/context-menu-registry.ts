type ActiveContextMenu = {
  id: string
  close: () => void
}

let activeContextMenuId: string | null = null
let activeContextMenuClose: (() => void) | null = null

export function setActiveContextMenu(nextMenu: ActiveContextMenu | null) {
  if (nextMenu && activeContextMenuId && activeContextMenuId !== nextMenu.id) {
    activeContextMenuClose?.()
  }

  activeContextMenuId = nextMenu?.id ?? null
  activeContextMenuClose = nextMenu?.close ?? null
}

export function clearActiveContextMenu(id: string) {
  if (activeContextMenuId === id) setActiveContextMenu(null)
}

export function isContextMenuOpen() {
  return activeContextMenuId !== null
}
