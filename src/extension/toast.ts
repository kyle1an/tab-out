export type ToastAction = {
  label: string
  onClick: () => void | Promise<void>
}
export type ToastPayload = {
  message: string
  action: ToastAction | null
}
type ToastDispatch = (toast: ToastPayload) => void

let activeDispatch: ToastDispatch | null = null
let pendingToast: ToastPayload | null = null

export function showToast(message: string, action: ToastAction | null = null): void {
  const incoming = { message, action }
  if (activeDispatch) {
    activeDispatch(incoming)
  } else {
    pendingToast = incoming
  }
}

export function registerToastDispatch(dispatch: ToastDispatch): () => void {
  activeDispatch = dispatch
  if (pendingToast) {
    activeDispatch(pendingToast)
    pendingToast = null
  }

  return () => {
    if (activeDispatch === dispatch) activeDispatch = null
  }
}
