export type ToastAction = {
  label: string
  description?: string
  onClick: () => void | Promise<void>
}

export type ToastPresenter = (title: string, action: ToastAction | null) => void
