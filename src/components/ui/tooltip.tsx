import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  ComponentProps,
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
  ReactElement,
  ReactNode
} from 'react'
// react-doctor-disable-next-line react-doctor/no-flush-sync -- instant tooltip close needs synchronous Base UI popup teardown.
import { flushSync } from 'react-dom'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { mergeRefs } from 'foxact/merge-refs'
import { useAbortableEffect } from 'foxact/use-abortable-effect'
import { useRetimer } from 'foxact/use-retimer'

import { cn } from '@/lib/utils'
import { isContextMenuOpen } from './context-menu-registry'

const TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS = 200
const TOOLTIP_INITIAL_REST_DELAY_MS = 500
const TOOLTIP_ADJACENT_REST_DELAY_MS = 180
const TOOLTIP_ADJACENT_REST_WINDOW_MS = 700
const TOOLTIP_HOVERABLE_CLOSE_DELAY_MS = 160
const TOOLTIP_HOVER_WATCH_INTERVAL_MS = 80
const TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS = 320
const TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX = 1
const TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS = 900
const TOOLTIP_WHEEL_TARGET_RELEASE_DELAY_MS = 320
const TOOLTIP_WHEEL_DELTA_LINE = 1
const TOOLTIP_WHEEL_DELTA_PAGE = 2
const TOOLTIP_WHEEL_LINE_HEIGHT_PX = 16
const TOOLTIP_COLLISION_AVOIDANCE: NonNullable<
  TooltipPrimitive.Positioner.Props['collisionAvoidance']
> = {
  side: 'flip',
  align: 'flip',
  fallbackAxisSide: 'none'
}

type TooltipProviderProps = {
  children?: ReactNode
}

let activeTooltipAnchorId: string | null = null
let latestTooltipActivityAt = 0
let wheelClosedTooltipBlockedUntil = 0
let tooltipWheelForwardContainer: HTMLElement | null = null
let tooltipWheelForwardUntil = 0
let tooltipWheelForwardClearTimer: number | null = null
let tooltipWheelForwardListenerInstalled = false
let tooltipWheelForwardRefresh: (() => void) | null = null
let tooltipWheelForwardOwnerId: string | null = null

function now() {
  return performance.now()
}

function shouldUseAdjacentTooltipDelay(anchorId: string) {
  const hasActiveOtherTooltip =
    activeTooltipAnchorId !== null && activeTooltipAnchorId !== anchorId
  const recentlyClosed =
    activeTooltipAnchorId === null &&
    latestTooltipActivityAt > 0 &&
    now() - latestTooltipActivityAt <= TOOLTIP_ADJACENT_REST_WINDOW_MS
  return hasActiveOtherTooltip || recentlyClosed
}

function tooltipOverflowAllowsScroll(value: string) {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

function tooltipScrollableAncestors(element: HTMLElement | null) {
  const ancestors: HTMLElement[] = []

  for (
    let candidate = element?.parentElement ?? null;
    candidate !== null;
    candidate = candidate.parentElement
  ) {
    const styles = window.getComputedStyle(candidate)
    const canScrollY =
      tooltipOverflowAllowsScroll(styles.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight
    const canScrollX =
      tooltipOverflowAllowsScroll(styles.overflowX) &&
      candidate.scrollWidth > candidate.clientWidth

    if (canScrollY || canScrollX) {
      ancestors.push(candidate)
    }
  }

  const scrollingElement = document.scrollingElement
  if (scrollingElement instanceof HTMLElement) {
    const alreadyIncluded = new Set(ancestors).has(scrollingElement)
    const canScrollPage =
      scrollingElement.scrollHeight > scrollingElement.clientHeight ||
      scrollingElement.scrollWidth > scrollingElement.clientWidth
    if (!alreadyIncluded && canScrollPage) {
      ancestors.push(scrollingElement)
    }
  }

  return ancestors
}

function uniqueTooltipScrollableAncestors(
  scrollContainers: readonly HTMLElement[]
) {
  const uniqueAncestors: HTMLElement[] = []
  const seenAncestors = new Set<HTMLElement>()
  for (const scrollContainer of scrollContainers) {
    if (!seenAncestors.has(scrollContainer)) {
      seenAncestors.add(scrollContainer)
      uniqueAncestors.push(scrollContainer)
    }
  }
  return uniqueAncestors
}

function tooltipScrollableAncestorsUnderPoint(
  x: number,
  y: number,
  popupElement: HTMLElement | null
) {
  const passthroughTargets = [popupElement, popupElement?.parentElement].filter(
    (target): target is HTMLElement => !!target
  )
  const previousPointerEvents = passthroughTargets.map((target) =>
    target.style.getPropertyValue('pointer-events')
  )

  for (const target of passthroughTargets) {
    target.style.setProperty('pointer-events', 'none')
  }

  try {
    const element = document.elementFromPoint(x, y)
    return tooltipScrollableAncestors(
      element instanceof HTMLElement ? element : null
    )
  } finally {
    passthroughTargets.forEach((target, index) => {
      const previousValue = previousPointerEvents[index]
      if (previousValue) {
        target.style.setProperty('pointer-events', previousValue)
      } else {
        target.style.removeProperty('pointer-events')
      }
    })
  }
}

function tooltipWheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  pageSize: number
) {
  if (deltaMode === TOOLTIP_WHEEL_DELTA_LINE) {
    return delta * TOOLTIP_WHEEL_LINE_HEIGHT_PX
  }
  if (deltaMode === TOOLTIP_WHEEL_DELTA_PAGE) {
    return delta * pageSize
  }
  return delta
}

type TooltipWheelLike = Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>

function tooltipScrollElementByWheel(
  element: HTMLElement,
  event: TooltipWheelLike
) {
  const deltaX = tooltipWheelDeltaToPixels(
    event.deltaX,
    event.deltaMode,
    element.clientWidth
  )
  const deltaY = tooltipWheelDeltaToPixels(
    event.deltaY,
    event.deltaMode,
    element.clientHeight
  )
  const previousLeft = element.scrollLeft
  const previousTop = element.scrollTop

  if (deltaX !== 0) {
    element.scrollLeft += deltaX
  }
  if (deltaY !== 0) {
    element.scrollTop += deltaY
  }

  return element.scrollLeft !== previousLeft || element.scrollTop !== previousTop
}

function clearTooltipWheelForwarding(ownerId?: string) {
  if (ownerId && tooltipWheelForwardOwnerId !== ownerId) return
  tooltipWheelForwardContainer = null
  tooltipWheelForwardUntil = 0
  tooltipWheelForwardRefresh = null
  tooltipWheelForwardOwnerId = null
  if (tooltipWheelForwardClearTimer !== null) {
    window.clearTimeout(tooltipWheelForwardClearTimer)
    tooltipWheelForwardClearTimer = null
  }
  if (tooltipWheelForwardListenerInstalled) {
    window.removeEventListener('wheel', handleTooltipWheelForward, true)
    tooltipWheelForwardListenerInstalled = false
  }
}

function handleTooltipWheelForward(event: WheelEvent) {
  const scrollContainer = tooltipWheelForwardContainer
  if (
    !scrollContainer ||
    now() > tooltipWheelForwardUntil ||
    !document.contains(scrollContainer)
  ) {
    clearTooltipWheelForwarding()
    return
  }

  if (!tooltipScrollElementByWheel(scrollContainer, event)) {
    clearTooltipWheelForwarding()
    return
  }

  tooltipWheelForwardUntil = now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
  tooltipWheelForwardRefresh?.()
  event.preventDefault()
  event.stopPropagation()
}

function startTooltipWheelForwarding(
  scrollContainer: HTMLElement,
  ownerId: string,
  refreshWheelTarget: () => void
) {
  tooltipWheelForwardContainer = scrollContainer
  tooltipWheelForwardOwnerId = ownerId
  tooltipWheelForwardRefresh = refreshWheelTarget
  tooltipWheelForwardUntil = now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
  if (!tooltipWheelForwardListenerInstalled) {
    // react-doctor-disable-next-line react-doctor/client-passive-event-listeners -- wheel forwarding consumes the event after manual scroll.
    window.addEventListener('wheel', handleTooltipWheelForward, {
      capture: true,
      passive: false
    })
    tooltipWheelForwardListenerInstalled = true
  }
  if (tooltipWheelForwardClearTimer !== null) {
    window.clearTimeout(tooltipWheelForwardClearTimer)
  }
  tooltipWheelForwardClearTimer = window.setTimeout(
    clearTooltipWheelForwarding,
    TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
  )
}

function setTooltipWheelPassthrough(
  element: HTMLElement | null,
  enabled: boolean
) {
  const targets = [element, element?.parentElement]
  for (const target of targets) {
    if (!target) continue
    if (enabled) target.style.setProperty('pointer-events', 'none')
    else target.style.removeProperty('pointer-events')
  }
}

function releaseActiveTooltipAnchor(anchorId: string) {
  if (activeTooltipAnchorId !== anchorId) return
  activeTooltipAnchorId = null
  latestTooltipActivityAt = now()
}

function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>
}

function Tooltip({
  disableHoverablePopup = false,
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
  popupRef,
  side = 'bottom',
  sideOffset = 16,
  align = 'start',
  alignOffset = TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX,
  arrowPadding = 0,
  collisionAvoidance = TOOLTIP_COLLISION_AVOIDANCE,
  collisionPadding = 4,
  positionMethod,
  instant = false,
  children,
  onClick,
  onPointerDown,
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
  > & {
    instant?: boolean
    popupRef?: Ref<HTMLDivElement>
  }) {
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
          ref={popupRef}
          data-slot="tooltip-content"
          className={cn(
            'z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col rounded-[10px] bg-[canvas] px-2 py-1 text-sm leading-5 whitespace-normal text-tab-ink shadow-lg shadow-(--warm-gray) outline-1 outline-(--warm-gray) [corner-shape:squircle] [overflow-wrap:anywhere] data-[align=end]:data-[side=bottom]:rounded-tr-none data-[align=end]:data-[side=top]:rounded-br-none data-[align=start]:data-[side=bottom]:rounded-tl-none data-[align=start]:data-[side=top]:rounded-bl-none',
            instant
              ? 'transition-none'
              : 'transition-[transform,opacity] duration-150 data-ending-style:transform-[scale(0.9)] data-ending-style:opacity-0 data-starting-style:transform-[scale(0.9)] data-starting-style:opacity-0',
            className
          )}
          onClick={(event) => {
            onClick?.(event)
            event.stopPropagation()
          }}
          onPointerDown={(event) => {
            onPointerDown?.(event)
            event.stopPropagation()
          }}
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
  ref?: Ref<HTMLElement>
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void
}>

type TooltipAnchorProps = Omit<
  ComponentProps<typeof TooltipContent>,
  'children' | 'content' | 'onWheel'
> & {
  anchorToCursor?: boolean
  content?: ReactNode
  children: TooltipTriggerElement
  onOpenChange?: (open: boolean) => void
  onWheel?: (event: WheelEvent) => void
}

type TooltipAnchorControllerOptions = {
  anchorId: string
  anchorToCursor: boolean
  children: TooltipTriggerElement
  contentOnWheel?: (event: WheelEvent) => void
  onOpenChange?: (open: boolean) => void
  openInstantly: boolean
}

function useTooltipAnchorController({
  anchorId,
  anchorToCursor,
  children,
  contentOnWheel,
  onOpenChange,
  openInstantly
}: TooltipAnchorControllerOptions) {
  const tooltipActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null)
  const triggerElementRef = useRef<HTMLElement | null>(null)
  const popupElementRef = useRef<HTMLDivElement | null>(null)
  const latestPointerPointRef = useRef<CursorPoint | null>(null)
  const hoverDelayRef = useRef(TOOLTIP_INITIAL_REST_DELAY_MS)
  const pointerInsideRef = useRef(false)
  const pointerFocusedRef = useRef(false)
  const popupPointerInsideRef = useRef(false)
  const hoverOpenBlockedUntilRef = useRef(0)
  const hoverCloseScheduledRef = useRef(false)
  const tooltipWheelClosingRef = useRef(false)
  const handleContentWheelRef = useRef<(event: WheelEvent) => void>(() => {})
  const retimeFrozenPointerClear = useRetimer()
  const retimeHoverOpen = useRetimer()
  const retimeHoverClose = useRetimer()
  const retimeWheelClose = useRetimer()
  const [frozenPointerPoint, setFrozenPointerPoint] =
    useState<CursorPoint | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipWheelClosing, setTooltipWheelClosing] = useState(false)
  const [popupElement, setPopupElement] = useState<HTMLDivElement | null>(null)
  const closeInstantly = openInstantly

  const clearHoverCloseTimer = useCallback(() => {
    hoverCloseScheduledRef.current = false
    retimeHoverClose()
  }, [retimeHoverClose])

  const clearFrozenPointerPointAfterClose = useCallback(() => {
    retimeFrozenPointerClear(
      window.setTimeout(() => {
        setFrozenPointerPoint(null)
      }, TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS)
    )
  }, [retimeFrozenPointerClear])

  const setTooltipWheelClosingState = useCallback((closing: boolean) => {
    tooltipWheelClosingRef.current = closing
    setTooltipWheelClosing(closing)
  }, [])

  const isLatestPointerInsideTooltipRegion = useCallback(() => {
    const point = latestPointerPointRef.current
    if (!point) return false

    const target = document.elementFromPoint(point.x, point.y)
    if (!(target instanceof Node)) return false

    return !!(
      triggerElementRef.current?.contains(target) ||
      popupElementRef.current?.contains(target)
    )
  }, [])

  useEffect(
    () => () => {
      retimeFrozenPointerClear()
      clearHoverCloseTimer()
      retimeHoverOpen()
      retimeWheelClose()
      clearTooltipWheelForwarding(anchorId)
      releaseActiveTooltipAnchor(anchorId)
    },
    [anchorId, clearHoverCloseTimer, retimeFrozenPointerClear, retimeHoverOpen, retimeWheelClose]
  )

  const closeTooltip = useCallback(() => {
    retimeWheelClose()
    clearTooltipWheelForwarding(anchorId)
    setTooltipWheelClosingState(false)
    retimeHoverOpen()
    clearHoverCloseTimer()
    if (closeInstantly) {
      flushSync(() => {
        setTooltipOpen(false)
        onOpenChange?.(false)
      })
      tooltipActionsRef.current?.unmount()
    } else {
      setTooltipOpen(false)
      onOpenChange?.(false)
    }
    releaseActiveTooltipAnchor(anchorId)
    clearFrozenPointerPointAfterClose()
  }, [anchorId, clearFrozenPointerPointAfterClose, clearHoverCloseTimer, closeInstantly, onOpenChange, retimeHoverOpen, retimeWheelClose, setTooltipWheelClosingState])

  const openTooltip = useCallback((point: CursorPoint | null) => {
    retimeHoverOpen()
    retimeWheelClose()
    clearHoverCloseTimer()
    if (point !== null && now() < wheelClosedTooltipBlockedUntil) return
    if (point !== null && now() < hoverOpenBlockedUntilRef.current) return
    if (!pointerInsideRef.current && point !== null) return

    clearTooltipWheelForwarding(anchorId)
    setTooltipWheelClosingState(false)
    setTooltipWheelPassthrough(popupElementRef.current, false)
    activeTooltipAnchorId = anchorId
    latestTooltipActivityAt = now()
    setFrozenPointerPoint(point)
    setTooltipOpen(true)
    onOpenChange?.(true)
  }, [anchorId, clearHoverCloseTimer, onOpenChange, retimeHoverOpen, retimeWheelClose, setTooltipWheelClosingState])

  const scheduleHoverClose = useCallback(() => {
    if (tooltipWheelClosingRef.current) return
    if (isContextMenuOpen()) {
      clearHoverCloseTimer()
      return
    }
    retimeHoverOpen()
    clearHoverCloseTimer()

    if (closeInstantly) {
      if (isLatestPointerInsideTooltipRegion()) return
      closeTooltip()
      return
    }

    hoverCloseScheduledRef.current = true
    retimeHoverClose(window.setTimeout(() => {
      hoverCloseScheduledRef.current = false
      if (isContextMenuOpen()) return
      if (pointerInsideRef.current || popupPointerInsideRef.current) return

      closeTooltip()
    }, TOOLTIP_HOVERABLE_CLOSE_DELAY_MS))
  }, [clearHoverCloseTimer, closeInstantly, closeTooltip, isLatestPointerInsideTooltipRegion, retimeHoverClose, retimeHoverOpen])

  const scheduleTooltipWheelTargetRelease = useCallback(() => {
    setTooltipWheelClosingState(true)
    retimeWheelClose(window.setTimeout(() => {
      closeTooltip()
    }, TOOLTIP_WHEEL_TARGET_RELEASE_DELAY_MS))
  }, [closeTooltip, retimeWheelClose, setTooltipWheelClosingState])

  const beginTooltipWheelClose = useCallback(
    (scrollContainer: HTMLElement) => {
      startTooltipWheelForwarding(
        scrollContainer,
        anchorId,
        scheduleTooltipWheelTargetRelease
      )
      setTooltipWheelPassthrough(popupElementRef.current, true)
      pointerInsideRef.current = false
      popupPointerInsideRef.current = false
      wheelClosedTooltipBlockedUntil =
        now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
      hoverOpenBlockedUntilRef.current =
        now() + TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS
      retimeHoverOpen()
      clearHoverCloseTimer()
      releaseActiveTooltipAnchor(anchorId)
      flushSync(() => {
        scheduleTooltipWheelTargetRelease()
      })
    },
    [anchorId, clearHoverCloseTimer, retimeHoverOpen, scheduleTooltipWheelTargetRelease]
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

  const scheduleHoverOpen = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      updateLatestPointerPoint(event)
      retimeHoverOpen()

      const point = latestPointerPointRef.current
      if (openInstantly) {
        openTooltip(point)
        return
      }

      retimeHoverOpen(window.setTimeout(() => {
        openTooltip(point)
      }, hoverDelayRef.current))
    },
    [openInstantly, openTooltip, retimeHoverOpen, updateLatestPointerPoint]
  )

  useAbortableEffect((signal) => {
    if (!tooltipOpen) return

    const closeFromGlobalEvent = () => {
      pointerInsideRef.current = false
      popupPointerInsideRef.current = false
      hoverOpenBlockedUntilRef.current = now() + TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS
      closeTooltip()
    }
    const handleScroll = () => {
      if (tooltipWheelClosingRef.current) return
      closeFromGlobalEvent()
    }
    const handleWindowBlur = () => closeFromGlobalEvent()
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') closeFromGlobalEvent()
    }
    const isTooltipRegionActive = () => {
      const triggerElement = triggerElementRef.current
      const popupElement = popupElementRef.current
      const activeElement = document.activeElement
      const triggerHasFocus =
        !pointerFocusedRef.current &&
        activeElement instanceof Node &&
        !!triggerElement?.contains(activeElement)

      return !!(
        triggerHasFocus ||
        triggerElement?.matches(':hover') ||
        popupElement?.matches(':hover')
      )
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (tooltipWheelClosingRef.current) return
      if (isContextMenuOpen()) return
      latestPointerPointRef.current = {
        x: event.clientX,
        y: event.clientY
      }
      const target = event.target instanceof Node ? event.target : null
      const isInsideTooltipRegion =
        target !== null &&
        (triggerElementRef.current?.contains(target) ||
          popupElementRef.current?.contains(target))

      if (isInsideTooltipRegion) return

      pointerInsideRef.current = false
      popupPointerInsideRef.current = false
      if (!hoverCloseScheduledRef.current) {
        scheduleHoverClose()
      }
    }
    const hoverWatchId = window.setInterval(() => {
      if (tooltipWheelClosingRef.current) return
      if (isContextMenuOpen()) {
        clearHoverCloseTimer()
        return
      }
      if (isTooltipRegionActive()) {
        clearHoverCloseTimer()
        return
      }
      if (!hoverCloseScheduledRef.current) {
        scheduleHoverClose()
      }
    }, TOOLTIP_HOVER_WATCH_INTERVAL_MS)

    window.addEventListener('scroll', handleScroll, { capture: true, passive: true, signal })
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true, signal })
    window.addEventListener('blur', handleWindowBlur, { signal })
    window.addEventListener('pointermove', handlePointerMove, { capture: true, signal })
    document.addEventListener('visibilitychange', handleVisibilityChange, { signal })
    return () => {
      window.clearInterval(hoverWatchId)
    }
  }, [clearHoverCloseTimer, closeTooltip, scheduleHoverClose, tooltipOpen])

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event)
      if (now() < hoverOpenBlockedUntilRef.current) return
      pointerInsideRef.current = true
      clearHoverCloseTimer()
      hoverDelayRef.current = shouldUseAdjacentTooltipDelay(anchorId)
        ? TOOLTIP_ADJACENT_REST_DELAY_MS
        : TOOLTIP_INITIAL_REST_DELAY_MS
      scheduleHoverOpen(event)
    },
    [anchorId, children.props, clearHoverCloseTimer, scheduleHoverOpen]
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerDown?.(event)
      if (event.button !== 0 || event.ctrlKey) return
      pointerFocusedRef.current = true
      closeTooltip()
    },
    [children.props, closeTooltip]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerMove?.(event)
      if (now() < hoverOpenBlockedUntilRef.current) return
      if (!pointerInsideRef.current) {
        pointerInsideRef.current = true
      }
      if (tooltipOpen) {
        updateLatestPointerPoint(event)
        return
      }
      scheduleHoverOpen(event)
    },
    [children.props, scheduleHoverOpen, tooltipOpen, updateLatestPointerPoint]
  )

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event)
      updateLatestPointerPoint(event)
      pointerInsideRef.current = false
      if (tooltipOpen) {
        scheduleHoverClose()
      } else {
        closeTooltip()
      }
    },
    [children.props, closeTooltip, scheduleHoverClose, tooltipOpen, updateLatestPointerPoint]
  )

  const handleFocus = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event)
      const focusVisible = event.currentTarget.matches(':focus-visible')
      pointerFocusedRef.current = !focusVisible
      if (!focusVisible) return
      openTooltip(null)
    },
    [children.props, openTooltip]
  )

  const handleBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      pointerFocusedRef.current = false
      closeTooltip()
    },
    [children.props, closeTooltip]
  )

  const markContentPointerInside = useCallback(() => {
    setTooltipWheelPassthrough(popupElementRef.current, false)
    pointerInsideRef.current = false
    popupPointerInsideRef.current = true
    clearHoverCloseTimer()
  }, [clearHoverCloseTimer])

  const markContentPointerOutside = useCallback(() => {
    popupPointerInsideRef.current = false
    scheduleHoverClose()
  }, [scheduleHoverClose])

  const handleContentPointerEnter = useCallback(
    (_event: ReactPointerEvent<HTMLDivElement>) => {
      markContentPointerInside()
    },
    [markContentPointerInside]
  )

  const handleContentPointerLeave = useCallback(
    (_event: ReactPointerEvent<HTMLDivElement>) => {
      markContentPointerOutside()
    },
    [markContentPointerOutside]
  )

  const handleContentMouseEnter = useCallback(
    (_event: ReactMouseEvent<HTMLDivElement>) => {
      markContentPointerInside()
    },
    [markContentPointerInside]
  )

  const handleContentMouseLeave = useCallback(
    (_event: ReactMouseEvent<HTMLDivElement>) => {
      markContentPointerOutside()
    },
    [markContentPointerOutside]
  )

  const handleContentWheel = useCallback(
    (event: WheelEvent) => {
      contentOnWheel?.(event)
      if (event.defaultPrevented) return

      const scrollContainers = uniqueTooltipScrollableAncestors(
        [
          ...tooltipScrollableAncestorsUnderPoint(
            event.clientX,
            event.clientY,
            popupElementRef.current
          ),
          ...tooltipScrollableAncestors(triggerElementRef.current)
        ]
      )
      for (const scrollContainer of scrollContainers) {
        if (tooltipScrollElementByWheel(scrollContainer, event)) {
          beginTooltipWheelClose(scrollContainer)
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }
    },
    [beginTooltipWheelClose, contentOnWheel]
  )

  useEffect(() => {
    handleContentWheelRef.current = handleContentWheel
  }, [handleContentWheel])

  useAbortableEffect((signal) => {
    if (!tooltipOpen || !popupElement) return

    function handleWheel(event: WheelEvent) {
      handleContentWheelRef.current(event)
    }

    // react-doctor-disable-next-line react-doctor/client-passive-event-listeners -- nested tooltip scrolling calls preventDefault after manual scroll.
    popupElement.addEventListener('wheel', handleWheel, { passive: false, signal })
  }, [popupElement, tooltipOpen])

  const triggerRef = useMemo(
    () => mergeRefs<HTMLElement>(children.props.ref, triggerElementRef),
    [children.props.ref]
  )
  const popupRef = useMemo(
    () => mergeRefs<HTMLDivElement>(popupElementRef, setPopupElement),
    []
  )

  const trigger = useMemo(
    () =>
      cloneElement(children, {
        onBlur: handleBlur,
        onFocus: handleFocus,
        onPointerDown: handlePointerDown,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave,
        onPointerMove: handlePointerMove,
        ref: triggerRef
      }),
    [children, handleBlur, handleFocus, handlePointerDown, handlePointerEnter, handlePointerLeave, handlePointerMove, triggerRef]
  )

  const cursorAnchor = useMemo(() => {
    if (!frozenPointerPoint) return undefined

    return {
      getBoundingClientRect: () =>
        new DOMRect(frozenPointerPoint.x, frozenPointerPoint.y, 0, 0)
    }
  }, [frozenPointerPoint])
  const tooltipAnchor = anchorToCursor ? cursorAnchor : undefined

  return {
    handleContentMouseEnter,
    handleContentMouseLeave,
    handleContentPointerEnter,
    handleContentPointerLeave,
    popupRef,
    tooltipActionsRef,
    tooltipAnchor,
    tooltipOpen,
    tooltipWheelClosing,
    trigger
  }
}

function TooltipAnchor({
  anchorToCursor = true,
  content,
  children,
  onOpenChange,
  onWheel: contentOnWheel,
  ...contentProps
}: TooltipAnchorProps) {
  const anchorId = useId()
  const {
    handleContentMouseEnter,
    handleContentMouseLeave,
    handleContentPointerEnter,
    handleContentPointerLeave,
    popupRef,
    tooltipActionsRef,
    tooltipAnchor,
    tooltipOpen,
    tooltipWheelClosing,
    trigger
  } = useTooltipAnchorController({
    anchorId,
    anchorToCursor,
    children,
    contentOnWheel,
    onOpenChange,
    openInstantly: contentProps.instant === true
  })

  if (content === null || content === undefined || content === '') return children

  return (
    <Tooltip actionsRef={tooltipActionsRef} open={tooltipOpen}>
      <TooltipTrigger render={trigger} disabled />
      <TooltipContent
        anchor={tooltipAnchor}
        popupRef={popupRef}
        positionMethod={tooltipAnchor ? 'fixed' : undefined}
        data-tooltip-wheel-closing={tooltipWheelClosing ? '' : undefined}
        onMouseEnter={handleContentMouseEnter}
        onMouseLeave={handleContentMouseLeave}
        onPointerEnter={handleContentPointerEnter}
        onPointerLeave={handleContentPointerLeave}
        {...contentProps}
        className={cn(contentProps.className, tooltipWheelClosing && 'opacity-0')}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipAnchor }
