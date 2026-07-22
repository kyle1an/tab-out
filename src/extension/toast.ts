export type ToastAction = {
  label: string
  description?: string
  onClick: () => void | Promise<void>
}

type ToastRuntime = typeof import('../components/mountToast')

let toastRuntimePromise: Promise<ToastRuntime> | null = null

function loadToastRuntime(): Promise<ToastRuntime> {
  if (!toastRuntimePromise) {
    toastRuntimePromise = import('../components/mountToast').catch((error) => {
      toastRuntimePromise = null
      throw error
    })
  }
  return toastRuntimePromise
}

export function showToast(title: string, action: ToastAction | null = null): void {
  // Toasts are a page-only enhancement. Some shared action modules also run
  // in tests or worker-like contexts, where importing the React mount would
  // fail after doing unnecessary chunk work.
  if (
    typeof document === 'undefined' ||
    typeof document.getElementById !== 'function' ||
    !document.body
  ) return
  void loadToastRuntime()
    .then(({ showMountedToast }) => showMountedToast(title, action))
    .catch((error: unknown) => {
      console.error('Could not load toast UI', error)
    })
}
