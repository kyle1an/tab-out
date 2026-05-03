import { useCallback, useEffect, useRef, useState } from 'react'

const URL_PREVIEW_HIDE_DELAY_MS = 120

type UrlPreviewState = {
  url: string
  visible: boolean
}

type TimerRef = {
  current: number | null
}

function clearHideTimer(timerRef: TimerRef) {
  if (timerRef.current === null) return
  clearTimeout(timerRef.current)
  timerRef.current = null
}

export function useUrlPreview() {
  const [urlPreview, setUrlPreviewState] = useState<UrlPreviewState>({ url: '', visible: false })
  const hideTimerRef = useRef<number | null>(null)

  const setUrlPreview = useCallback(function setUrlPreview(url: string) {
    const nextUrl = url || ''
    if (nextUrl) {
      clearHideTimer(hideTimerRef)
      setUrlPreviewState((prev) => (prev.url === nextUrl && prev.visible ? prev : { url: nextUrl, visible: true }))
      return
    }

    clearHideTimer(hideTimerRef)
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setUrlPreviewState((prev) => (prev.visible ? { ...prev, visible: false } : prev))
    }, URL_PREVIEW_HIDE_DELAY_MS)
  }, [])

  const clearUrlPreviewNow = useCallback(function clearUrlPreviewNow() {
    clearHideTimer(hideTimerRef)
    setUrlPreviewState((prev) => (prev.url || prev.visible ? { url: '', visible: false } : prev))
  }, [])

  useEffect(() => () => clearHideTimer(hideTimerRef), [])

  return { urlPreview, setUrlPreview, clearUrlPreviewNow }
}
