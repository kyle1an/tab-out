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
  alignOffset = 0,
  positionMethod,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'anchor' | 'positionMethod' | 'side' | 'sideOffset'
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col rounded-lg bg-[canvas] px-2 py-1 text-sm leading-5 whitespace-normal text-tab-ink shadow-lg shadow-[var(--warm-gray)] outline-1 outline-[var(--warm-gray)] transition-[transform,opacity] duration-150 [corner-shape:squircle] [overflow-wrap:anywhere] data-ending-style:transform-[scale(0.9)] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:transform-[scale(0.9)] data-starting-style:opacity-0',
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 flex data-[side=bottom]:-top-2 data-[side=bottom]:rotate-0 data-[side=inline-end]:left-[-13px] data-[side=inline-end]:-rotate-90 data-[side=inline-start]:right-[-13px] data-[side=inline-start]:rotate-90 data-[side=left]:right-[-13px] data-[side=left]:rotate-90 data-[side=right]:left-[-13px] data-[side=right]:-rotate-90 data-[side=top]:-bottom-2 data-[side=top]:rotate-180">
            <ArrowSvg />
          </TooltipPrimitive.Arrow>
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

function TooltipAnchor({
  content,
  children,
  ...contentProps
}: Omit<ComponentProps<typeof TooltipContent>, 'children'> & {
  content?: ReactNode
  children: TooltipTriggerElement
}) {
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

function ArrowSvg(props: ComponentProps<'svg'>) {
  return (
    <svg width="20" height="10" viewBox="0 0 20 10" fill="none" {...props}>
      <path
        d="M9.66437 2.60207L4.80758 6.97318C4.07308 7.63423 3.11989 8 2.13172 8H0V10H20V8H18.5349C17.5468 8 16.5936 7.63423 15.8591 6.97318L11.0023 2.60207C10.622 2.2598 10.0447 2.25979 9.66437 2.60207Z"
        className="fill-[canvas]"
      />
      <path
        d="M8.99542 1.85876C9.75604 1.17425 10.9106 1.17422 11.6713 1.85878L16.5281 6.22989C17.0789 6.72568 17.7938 7.00001 18.5349 7.00001L15.89 7L11.0023 2.60207C10.622 2.2598 10.0447 2.2598 9.66436 2.60207L4.77734 7L2.13171 7.00001C2.87284 7.00001 3.58774 6.72568 4.13861 6.22989L8.99542 1.85876Z"
        className="fill-[var(--warm-gray)]"
      />
      <path
        d="M10.3333 3.34539L5.47654 7.71648C4.55842 8.54279 3.36693 9 2.13172 9H0V8H2.13172C3.11989 8 4.07308 7.63423 4.80758 6.97318L9.66437 2.60207C10.0447 2.25979 10.622 2.2598 11.0023 2.60207L15.8591 6.97318C16.5936 7.63423 17.5468 8 18.5349 8H20V9H18.5349C17.2998 9 16.1083 8.54278 15.1901 7.71648L10.3333 3.34539Z"
        className="dark:fill-[var(--warm-gray)]"
      />
    </svg>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipAnchor }
