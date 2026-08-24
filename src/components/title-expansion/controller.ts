/* ================================================================
   Title Expansion controller — the headless open/close half of the
   Title Expansion engine (CONTEXT.md): hover-expanded titles open at
   most one overlay per surface lane. The controller still supports an
   optional close schedule, while the current tab-title surfaces close
   synchronously on pointer departure.

   The controller owns timing, lane arbitration, and expansion
   ownership. What counts as expandable, how the expanded lines are
   measured, and the overlay markup all stay with the adapting
   surface. Ownership is the keep-open mechanism: a held owner vetoes
   close() — including the fire-time re-check of a pending delayed
   close — and a held context menu additionally keeps the expansion
   through a lane steal, while keyboard focus yields the lane to the
   next hover. closeNow() and dispose() bypass owners.

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
    },
  }
}

const defaultScheduler: TitleExpansionScheduler = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The interaction surfaces that may keep an expansion open past its
 * normal close triggers (CONTEXT.md Title Expansion ownership).
 * @public — sanctioned seam surface; surfaces pass the literals, so no
 * import site names this union (docs/adr/0021).
 */
export type TitleExpansionOwner = 'context-menu' | 'keyboard-focus'

export type TitleExpansionControllerOptions = {
  id: string
  lane: TitleExpansionLane
  closeDelayMs: number
  onExpandedChange: (expanded: boolean) => void
  scheduler?: TitleExpansionScheduler
}

export type TitleExpansionController = {
  open: () => void
  close: (options?: { delayed?: boolean }) => void
  /** Collapse and release unconditionally — bypasses owners. */
  closeNow: () => void
  cancelPendingClose: () => void
  /**
   * Keep the expansion open while the owner is up. Holds are refcounted
   * per owner kind, so overlapping menus stay safe; the returned release
   * is idempotent.
   */
  hold: (owner: TitleExpansionOwner) => () => void
  isExpanded: () => boolean
  dispose: () => void
}

export function createTitleExpansionController({
  id,
  lane,
  closeDelayMs,
  onExpandedChange,
  scheduler = defaultScheduler,
}: TitleExpansionControllerOptions): TitleExpansionController {
  let expanded = false
  let pendingClose: unknown = null
  const holds = new Map<TitleExpansionOwner, number>()

  function setExpanded(next: boolean) {
    if (expanded === next) return
    expanded = next
    onExpandedChange(expanded)
  }

  function closeVetoed() {
    return holds.size > 0
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
    if (holds.has('context-menu')) return
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
      if (closeVetoed()) return
      if (!delayed) {
        collapseAndRelease()
        return
      }
      pendingClose = scheduler.set(() => {
        pendingClose = null
        if (closeVetoed()) return
        collapseAndRelease()
      }, closeDelayMs)
    },
    closeNow() {
      cancelPendingClose()
      collapseAndRelease()
    },
    cancelPendingClose,
    hold(owner) {
      holds.set(owner, (holds.get(owner) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = holds.get(owner) ?? 0
        if (count <= 1) holds.delete(owner)
        else holds.set(owner, count - 1)
      }
    },
    isExpanded() {
      return expanded
    },
    dispose() {
      cancelPendingClose()
      unsubscribe()
      lane.release(id)
      holds.clear()
    },
  }
}
