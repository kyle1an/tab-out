import { Toast as BaseToast } from '@base-ui/react/toast'
import type { ToastAction } from '../extension/toast.js'

const baseToastManager = BaseToast.createToastManager()
let markToastManagerReady: (() => void) | null = null
const toastManagerReady = new Promise<void>((resolve) => {
  markToastManagerReady = resolve
})
// The external manager does not retain events sent before its Provider subscribes.
// Resolve the first lazy toast only after that subscription is installed.
export const toastManager: typeof baseToastManager = {
  ...baseToastManager,
  ' subscribe': (listener) => {
    const unsubscribe = baseToastManager[' subscribe'](listener)
    markToastManagerReady?.()
    markToastManagerReady = null
    return unsubscribe
  }
}

export async function showToastInMountedRoot(
  title: string,
  action: ToastAction | null
): Promise<void> {
  await toastManagerReady
  const toastId = toastManager.add({
    title,
    description: action?.description,
    type: 'success',
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            toastManager.close(toastId)
            void action.onClick()
          }
        }
      : undefined
  })
}
