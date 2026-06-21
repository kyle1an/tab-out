import { lazy, Suspense, useState } from 'react'

const CardActionsMenuLoaded = lazy(() => import('./CardActionsMenuLoaded').then((module) => ({ default: module.CardActionsMenuLoaded })))

export interface CardActionsMenuProps {
  displayName: string
  label?: string
  onClose: () => void | Promise<void>
  suspendLabel?: string
  onSuspend?: () => void | Promise<void>
}

const triggerClassName = 'card-actions-menu-trigger z-2 grid size-[22px] shrink-0 cursor-pointer place-items-center self-start justify-self-end rounded-lg border border-transparent bg-transparent p-0 text-tab-muted opacity-0 pointer-events-none transition-[opacity,color,background,border-color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:pointer-events-auto group-hover/domain-block:opacity-100 hover:border-(--warm-gray) hover:bg-[rgba(82,82,82,0.06)] hover:text-tab-ink focus-visible:opacity-100 data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100 data-[popup-open]:border-(--warm-gray) data-[popup-open]:bg-[rgba(82,82,82,0.08)] data-[popup-open]:text-tab-ink'

function CardActionsMenuTriggerFallback({ displayName, onArm }: { displayName: string; onArm: () => void }) {
  return (
    <button
      type="button"
      data-tabout-part="card-menu"
      aria-haspopup="menu"
      aria-label={`Actions for ${displayName}`}
      className={triggerClassName}
      onFocus={onArm}
      onMouseDown={onArm}
      onPointerEnter={onArm}
    >
      <span className="icon-[lucide--ellipsis-vertical] size-[14px]" aria-hidden="true" />
    </button>
  )
}

export function CardActionsMenu(props: CardActionsMenuProps) {
  const [armed, setArmed] = useState(false)
  const fallback = <CardActionsMenuTriggerFallback displayName={props.displayName} onArm={() => setArmed(true)} />
  if (!armed) return fallback

  return (
    <Suspense fallback={fallback}>
      <CardActionsMenuLoaded {...props} />
    </Suspense>
  )
}
