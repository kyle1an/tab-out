import { useCallback, useEffect, useState } from 'react'

export const URL_PREVIEW_HIDE_DELAY_MS = 120

type UrlPreviewState = {
  url: string
  visible: boolean
}

export type UrlPreviewStore = {
  getSnapshot: () => UrlPreviewState
  subscribe: (listener: () => void) => () => void
}

export type UrlPreviewController = {
  clearUrlPreviewNow: () => void
  dispose: () => void
  setUrlPreview: (url: string) => void
  store: UrlPreviewStore
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export function createUrlPreviewController(): UrlPreviewController {
  let state: UrlPreviewState = { url: '', visible: false }
  let hideTimer: TimerHandle | null = null
  const listeners = new Set<() => void>()

  function update(next: UrlPreviewState) {
    if (state.url === next.url && state.visible === next.visible) return
    state = next
    for (const listener of listeners) listener()
  }

  function clearHideTimer() {
    if (hideTimer === null) return
    globalThis.clearTimeout(hideTimer)
    hideTimer = null
  }

  const store: UrlPreviewStore = {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  function setUrlPreview(url: string) {
    const nextUrl = url || ''
    if (nextUrl) {
      clearHideTimer()
      update({ url: nextUrl, visible: true })
      return
    }

    clearHideTimer()
    hideTimer = globalThis.setTimeout(() => {
      hideTimer = null
      if (state.visible) update({ ...state, visible: false })
    }, URL_PREVIEW_HIDE_DELAY_MS)
  }

  function clearUrlPreviewNow() {
    clearHideTimer()
    if (state.url || state.visible) update({ url: '', visible: false })
  }

  function dispose() {
    clearHideTimer()
    listeners.clear()
  }

  return { clearUrlPreviewNow, dispose, setUrlPreview, store }
}

export function useUrlPreview() {
  const [controller] = useState(createUrlPreviewController)
  const setUrlPreview = useCallback((url: string) => controller.setUrlPreview(url), [controller])
  const clearUrlPreviewNow = useCallback(() => controller.clearUrlPreviewNow(), [controller])

  useEffect(() => () => controller.dispose(), [controller])

  return { urlPreviewStore: controller.store, setUrlPreview, clearUrlPreviewNow }
}
