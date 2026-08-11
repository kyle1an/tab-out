import type { ToastAction, ToastPresenter } from '../lib/toast-contract.js'

export type { ToastAction } from '../lib/toast-contract.js'

let toastPresenter: ToastPresenter | null = null

export function installToastPresenter(presenter: ToastPresenter): () => void {
  toastPresenter = presenter
  return () => {
    if (toastPresenter === presenter) toastPresenter = null
  }
}

export function showToast(title: string, action: ToastAction | null = null): void {
  toastPresenter?.(title, action)
}
