// Shared visual tokens for the popover-style menus so the click dropdown (`ui/menu`)
// and the right-click context menu (`ui/context-menu`) can't drift apart.
export const menuPopupClassName =
  'relative isolate z-70 min-w-40 rounded-[15px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none [corner-shape:squircle]'

export const menuItemClassName =
  'relative flex min-h-6 min-w-36 cursor-default items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] leading-tight text-tab-ink outline-none select-none [corner-shape:squircle] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0'
