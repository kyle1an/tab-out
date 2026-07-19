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
  void loadToastRuntime()
    .then(({ showMountedToast }) => showMountedToast(title, action))
    .catch((error: unknown) => {
      console.error('Could not load toast UI', error)
    })
}
