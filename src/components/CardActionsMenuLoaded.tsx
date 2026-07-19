import { Menu, MenuContent, MenuItem, MenuTrigger } from './ui/menu'
import type { CardActionsMenuProps } from './CardActionsMenu'

export function CardActionsMenuLoaded({ displayName, label, onClose, suspendLabel, onSuspend }: CardActionsMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        data-tabout-part="card-menu"
        aria-label={`Actions for ${displayName}`}
        className="card-actions-menu-trigger z-2 grid size-[22px] shrink-0 cursor-pointer place-items-center self-start justify-self-end rounded-lg border border-transparent bg-transparent p-0 text-muted-foreground opacity-0 pointer-events-none transition-[opacity,color,background,border-color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:pointer-events-auto group-hover/domain-block:opacity-100 hover:border-(--warm-gray) hover:bg-[rgba(82,82,82,0.06)] hover:text-foreground focus-visible:opacity-100 data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100 data-[popup-open]:border-(--warm-gray) data-[popup-open]:bg-[rgba(82,82,82,0.08)] data-[popup-open]:text-foreground"
      >
        <span className="icon-[lucide--ellipsis-vertical] size-[14px]" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        {suspendLabel && onSuspend && (
          <MenuItem
            data-tabout-part="suspend-button"
            className="card-actions-suspend-item"
            label={suspendLabel}
            onClick={onSuspend}
          >
            <span className="icon-[lucide--circle-pause] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">{suspendLabel}</span>
          </MenuItem>
        )}
        <MenuItem
          data-tabout-part="close-button"
          className="card-actions-close-item data-highlighted:text-(--status-abandoned)!"
          label={label}
          onClick={onClose}
        >
          <span className="icon-[lucide--x] size-3.5" aria-hidden="true" />
          {label && <span className="min-w-0 flex-1">{label}</span>}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
