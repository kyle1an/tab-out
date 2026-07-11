/* ================================================================
   Title Expansion controller — the headless open/close half of the
   Title Expansion engine (CONTEXT.md): hover-expanded titles open at
   most one overlay per surface lane, and a closing overlay survives a
   short grace delay so pointer travel doesn't blink it shut.

   The controller owns timing and lane arbitration only. What counts
   as expandable, how the expanded lines are measured, and the overlay
   markup all stay with the adapting surface. Per-surface behavior
   differences ride in as config: the close-veto predicates exist
   because Page Chips keep an expansion open while their context menu
   is up (checked again when a pending close fires), while history
   rows guard at their call sites instead.

   The scheduler is injectable so the delay logic tests under node
   with a fake clock; production uses setTimeout.
   ================================================================ */

export type TitleExpansionScheduler = {
  set: (fn: () => void, delayMs: number) => unknown
  clear: (handle: unknown) => void
}

export type TitleExpansionLane = {
  activate: (id: string) => void
  release: (id: string) => void
  subscribe: (subscriber: (activeId: string | null) => void) => () => void
  getActiveId: () => string | null
}

/**
 * One lane per surface kind (Page Chips, Activation History rows) —
 * the "at most one expanded title per surface" rule lives here.
 * Panels may subscribe directly to track which element is expanded.
 */
export function createTitleExpansionLane(): TitleExpansionLane {
  let activeId: string | null = null
  const subscribers = new Set<(activeId: string | null) => void>()

  function setActiveId(next: string | null) {
    if (activeId === next) return
    activeId = next
    for (const subscriber of subscribers) subscriber(activeId)
  }

  return {
    activate(id) {
      setActiveId(id)
    },
    release(id) {
      if (activeId === id) setActiveId(null)
    },
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    getActiveId() {
      return activeId
    }
  }
}

const defaultScheduler: TitleExpansionScheduler = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export type TitleExpansionControllerOptions = {
  id: string
  lane: TitleExpansionLane
  closeDelayMs: number
  onExpandedChange: (expanded: boolean) => void
  /** Veto a close (and any pending delayed close, re-checked at fire time). */
  shouldCancelClose?: () => boolean
  /** Keep this element expanded when another element takes the lane. */
  shouldIgnoreLaneSteal?: () => boolean
  scheduler?: TitleExpansionScheduler
}

export type TitleExpansionController = {
  open: () => void
  close: (options?: { delayed?: boolean }) => void
  /** Collapse and release unconditionally — bypasses shouldCancelClose. */
  closeNow: () => void
  cancelPendingClose: () => void
  isExpanded: () => boolean
  dispose: () => void
}

export function createTitleExpansionController({
  id,
  lane,
  closeDelayMs,
  onExpandedChange,
  shouldCancelClose,
  shouldIgnoreLaneSteal,
  scheduler = defaultScheduler
}: TitleExpansionControllerOptions): TitleExpansionController {
  let expanded = false
  let pendingClose: unknown = null

  function setExpanded(next: boolean) {
    if (expanded === next) return
    expanded = next
    onExpandedChange(expanded)
  }

  function cancelPendingClose() {
    if (pendingClose === null) return
    scheduler.clear(pendingClose)
    pendingClose = null
  }

  // Release before collapsing, and only when still the owner: a delayed
  // close that fires after another element stole the lane must not tear
  // down the new owner's activation.
  function collapseAndRelease() {
    lane.release(id)
    setExpanded(false)
  }

  const unsubscribe = lane.subscribe((activeId) => {
    if (activeId === id) return
    if (shouldIgnoreLaneSteal?.()) return
    setExpanded(false)
  })

  return {
    open() {
      cancelPendingClose()
      lane.activate(id)
      setExpanded(true)
    },
    close({ delayed = true } = {}) {
      cancelPendingClose()
      if (shouldCancelClose?.()) return
      if (!delayed) {
        collapseAndRelease()
        return
      }
      pendingClose = scheduler.set(() => {
        pendingClose = null
        if (shouldCancelClose?.()) return
        collapseAndRelease()
      }, closeDelayMs)
    },
    closeNow() {
      cancelPendingClose()
      collapseAndRelease()
    },
    cancelPendingClose,
    isExpanded() {
      return expanded
    },
    dispose() {
      cancelPendingClose()
      unsubscribe()
      lane.release(id)
    }
  }
}
