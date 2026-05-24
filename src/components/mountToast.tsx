import { createRoot } from 'react-dom/client'
import { Toast } from './Toast'

export function mountToast() {
  const el = document.getElementById('toastRoot')
  if (!el) return
  createRoot(el).render(<Toast />)
}
