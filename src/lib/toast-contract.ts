export type ToastAction = {
  label: string
  description?: string
  onClick: () => void | Promise<void>
}

export type ToastOptions = {
  /** A value of zero keeps the toast open until the user dismisses it. */
  timeout?: number
}

export type ToastPresenter = (
  title: string,
  action: ToastAction | null,
  options?: ToastOptions,
) => void
