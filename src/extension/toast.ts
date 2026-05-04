import { Toast } from '@base-ui/react/toast'

export type ToastAction = {
  label: string
  description?: string
  onClick: () => void | Promise<void>
}

export const toastManager = Toast.createToastManager()

export function showToast(title: string, action: ToastAction | null = null): void {
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
