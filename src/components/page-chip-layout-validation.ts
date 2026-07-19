const pageChipTextLayoutValidationCallbacks = new WeakMap<HTMLElement, () => void>()

export function registerPageChipTextLayoutValidation(textEl: HTMLElement, validate: () => void) {
  pageChipTextLayoutValidationCallbacks.set(textEl, validate)
  return () => {
    if (pageChipTextLayoutValidationCallbacks.get(textEl) === validate) {
      pageChipTextLayoutValidationCallbacks.delete(textEl)
    }
  }
}

export function validatePageChipTextLayoutsAfterMasonry(containers: Array<HTMLElement | null>) {
  for (const container of containers) {
    if (!container) continue
    for (const textEl of container.querySelectorAll<HTMLElement>('.chip-text')) {
      pageChipTextLayoutValidationCallbacks.get(textEl)?.()
    }
  }
}
