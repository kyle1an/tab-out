import { useEffect, useRef, useState } from 'react'

const URL_PREVIEW_HIDE_DELAY_MS = 120

type UrlPreviewState = {
  url: string
  visible: boolean
}

export function useUrlPreview() {
  const [urlPreview, setUrlPreviewState] = useState<UrlPreviewState>({ url: '', visible: false })
  const hideTimerRef = useRef<number | null>(null)

  function clearHideTimer() {
    if (hideTimerRef.current === null) return
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }

  function setUrlPreview(url: string) {
    const nextUrl = url || ''
    if (nextUrl) {
      clearHideTimer()
      setUrlPreviewState((prev) => (prev.url === nextUrl && prev.visible ? prev : { url: nextUrl, visible: true }))
      return
    }

    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setUrlPreviewState((prev) => (prev.visible ? { ...prev, visible: false } : prev))
    }, URL_PREVIEW_HIDE_DELAY_MS)
  }

  function clearUrlPreviewNow() {
    clearHideTimer()
    setUrlPreviewState((prev) => (prev.url || prev.visible ? { url: '', visible: false } : prev))
  }

  useEffect(() => () => clearHideTimer(), [])

  return { urlPreview, setUrlPreview, clearUrlPreviewNow }
}
