import type {
  ToastAction,
  ToastOptions,
  ToastPresenter,
} from '../lib/toast-contract.js'

export type { ToastAction, ToastOptions } from '../lib/toast-contract.js'

let toastPresenter: ToastPresenter | null = null

export function installToastPresenter(presenter: ToastPresenter): () => void {
  toastPresenter = presenter
  return () => {
    if (toastPresenter === presenter) toastPresenter = null
  }
}

export function showToast(
  title: string,
  action: ToastAction | null = null,
  options?: ToastOptions,
): void {
  toastPresenter?.(title, action, options)
}
