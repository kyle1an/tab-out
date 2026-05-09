import {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  ComponentProps,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode
} from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

import { cn } from '@/lib/utils'

const TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS = 200
const TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX = 1
const TOOLTIP_COLLISION_AVOIDANCE: NonNullable<
  TooltipPrimitive.Positioner.Props['collisionAvoidance']
> = {
  side: 'flip',
  align: 'flip',
  fallbackAxisSide: 'none'
}

function TooltipProvider({
  delay = 500,
  closeDelay = 0,
  timeout = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
      {...props}
    />
  )
}

function Tooltip({
  disableHoverablePopup = true,
  trackCursorAxis = 'none',
  ...props
}: TooltipPrimitive.Root.Props) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverablePopup={disableHoverablePopup}
      trackCursorAxis={trackCursorAxis}
      {...props}
    />
  )
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  anchor,
  side = 'bottom',
  sideOffset = 10,
  align = 'start',
  alignOffset = TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX,
  arrowPadding = 0,
  collisionAvoidance = TOOLTIP_COLLISION_AVOIDANCE,
  collisionPadding = 0,
  positionMethod,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    | 'align'
    | 'alignOffset'
    | 'anchor'
    | 'arrowPadding'
    | 'collisionAvoidance'
    | 'collisionPadding'
    | 'positionMethod'
    | 'side'
    | 'sideOffset'
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        arrowPadding={arrowPadding}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col rounded-lg bg-[canvas] px-2 py-1 text-sm leading-5 whitespace-normal text-tab-ink shadow-lg shadow-[var(--warm-gray)] outline-1 outline-[var(--warm-gray)] transition-[transform,opacity] duration-150 [corner-shape:squircle] [overflow-wrap:anywhere] data-[align=end]:data-[side=bottom]:rounded-tr-none data-[align=end]:data-[side=top]:rounded-br-none data-[align=start]:data-[side=bottom]:rounded-tl-none data-[align=start]:data-[side=top]:rounded-bl-none data-ending-style:transform-[scale(0.9)] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:transform-[scale(0.9)] data-starting-style:opacity-0',
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

type CursorPoint = {
  x: number
  y: number
}

type TooltipTriggerElement = ReactElement<{
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void
}>

type TooltipAnchorProps = Omit<
  ComponentProps<typeof TooltipContent>,
  'children' | 'content'
> & {
  content?: ReactNode
  children: TooltipTriggerElement
}

function TooltipAnchor({
  content,
  children,
  ...contentProps
}: TooltipAnchorProps) {
  const latestPointerPointRef = useRef<CursorPoint | null>(null)
  const frozenPointerClearTimerRef = useRef<number | null>(null)
  const [frozenPointerPoint, setFrozenPointerPoint] =
    useState<CursorPoint | null>(null)

  const clearFrozenPointerClearTimer = useCallback(() => {
    if (frozenPointerClearTimerRef.current === null) return

    window.clearTimeout(frozenPointerClearTimerRef.current)
    frozenPointerClearTimerRef.current = null
  }, [])

  const clearFrozenPointerPointAfterClose = useCallback(() => {
    clearFrozenPointerClearTimer()
    frozenPointerClearTimerRef.current = window.setTimeout(() => {
      setFrozenPointerPoint(null)
      frozenPointerClearTimerRef.current = null
    }, TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS)
  }, [clearFrozenPointerClearTimer])

  useEffect(
    () => () => {
      clearFrozenPointerClearTimer()
    },
    [clearFrozenPointerClearTimer]
  )

  const updateLatestPointerPoint = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      latestPointerPointRef.current = {
        x: event.clientX,
        y: event.clientY
      }
    },
    []
  )

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event)
      updateLatestPointerPoint(event)
    },
    [children.props, updateLatestPointerPoint]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerMove?.(event)
      updateLatestPointerPoint(event)
    },
    [children.props, updateLatestPointerPoint]
  )

  const trigger = useMemo(
    () =>
      cloneElement(children, {
        onPointerEnter: handlePointerEnter,
        onPointerMove: handlePointerMove
      }),
    [children, handlePointerEnter, handlePointerMove]
  )

  const cursorAnchor = useMemo(() => {
    if (!frozenPointerPoint) return undefined

    return {
      getBoundingClientRect: () =>
        new DOMRect(frozenPointerPoint.x, frozenPointerPoint.y, 0, 0)
    }
  }, [frozenPointerPoint])

  const handleOpenChange = useCallback(
    (
      open: boolean,
      eventDetails: TooltipPrimitive.Root.ChangeEventDetails
    ) => {
      if (!open) {
        clearFrozenPointerPointAfterClose()
        return
      }

      clearFrozenPointerClearTimer()

      if (eventDetails.reason !== 'trigger-hover') {
        setFrozenPointerPoint(null)
        return
      }

      const nativeEvent = eventDetails.event
      const point =
        latestPointerPointRef.current ??
        ('clientX' in nativeEvent && 'clientY' in nativeEvent
          ? { x: nativeEvent.clientX, y: nativeEvent.clientY }
          : null)

      setFrozenPointerPoint(point)
    },
    [clearFrozenPointerClearTimer, clearFrozenPointerPointAfterClose]
  )

  if (content === null || content === undefined || content === '') return children

  return (
    <Tooltip onOpenChange={handleOpenChange}>
      <TooltipTrigger render={trigger} />
      <TooltipContent
        anchor={cursorAnchor}
        positionMethod={cursorAnchor ? 'fixed' : undefined}
        {...contentProps}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipAnchor }
