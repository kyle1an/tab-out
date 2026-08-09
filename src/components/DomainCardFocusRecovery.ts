import { resolvePageChipFocusRecoveryCard } from './PageChipFocusRecovery'

const FILTER_QUERY_INPUT_SELECTOR = '[data-tabout="filter-query"] [data-tabout-part="input"]'
const CARD_MENU_TRIGGER_SELECTOR = '[data-tabout-part="card-menu"]'

function focusCanStillTransfer(
  ownerDocument: Document,
  capturedCard: HTMLElement,
  capturedTrigger: HTMLElement | null
): 'ready' | 'wait' | 'cancel' {
  const activeElement = ownerDocument.activeElement
  if (
    !activeElement ||
    activeElement === ownerDocument.body ||
    activeElement === ownerDocument.documentElement ||
    activeElement === capturedTrigger ||
    capturedCard.contains(activeElement)
  ) {
    return 'ready'
  }
  if (
    activeElement instanceof HTMLElement &&
    activeElement.closest('[data-slot="menu-content"]')
  ) {
    return 'wait'
  }
  return 'cancel'
}

/** Keep keyboard focus useful when a card-menu mutation removes its whole card. */
export function captureDomainCardFocusRecovery(
  capturedCard: HTMLElement | null
) {
  if (!capturedCard) return null
  const domainCard = capturedCard
  const ownerDocument = domainCard.ownerDocument
  const capturedTrigger = domainCard.querySelector<HTMLElement>(CARD_MENU_TRIGGER_SELECTOR)
  const domain = domainCard.dataset.taboutDomain
  const missionGridId = domainCard.closest<HTMLElement>('.missions[id]')?.id
  let disposed = false
  let observer: MutationObserver | null = null
  let animationFrame = 0

  function dispose() {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    observer = null
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    ownerDocument.removeEventListener('visibilitychange', schedule)
  }

  function recoverFocus() {
    animationFrame = 0
    if (disposed || ownerDocument.visibilityState !== 'visible') return

    const transferState = focusCanStillTransfer(
      ownerDocument,
      domainCard,
      capturedTrigger
    )
    if (transferState === 'wait') return
    if (transferState === 'cancel') {
      dispose()
      return
    }

    const card = resolvePageChipFocusRecoveryCard(
      ownerDocument,
      domainCard,
      missionGridId,
      domain
    )
    if (card) {
      const trigger = card.querySelector<HTMLElement>(CARD_MENU_TRIGGER_SELECTOR)
      if (trigger) {
        trigger.focus({ preventScroll: true })
        dispose()
        return
      }
    }

    ownerDocument.querySelector<HTMLElement>(FILTER_QUERY_INPUT_SELECTOR)
      ?.focus({ preventScroll: true })
    dispose()
  }

  function schedule() {
    if (disposed || ownerDocument.visibilityState !== 'visible') return
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    animationFrame = requestAnimationFrame(recoverFocus)
  }

  return () => {
    observer = new MutationObserver(schedule)
    observer.observe(ownerDocument.documentElement, { childList: true, subtree: true })
    ownerDocument.addEventListener('visibilitychange', schedule)
    schedule()
  }
}
