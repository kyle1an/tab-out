import { createRoot } from 'react-dom/client'
import type { ToastAction } from '../extension/toast.js'
import { Toast } from './Toast'
import { showToastInMountedRoot } from './toast-runtime'

let toastMounted = false

function mountToast() {
  if (toastMounted) return true
  const el = document.getElementById('toastRoot')
  if (!el) return false
  toastMounted = true
  createRoot(el).render(<Toast />)
  return true
}

export async function showMountedToast(
  title: string,
  action: ToastAction | null,
): Promise<void> {
  if (!mountToast()) return
  await showToastInMountedRoot(title, action)
}
