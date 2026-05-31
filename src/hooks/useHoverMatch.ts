import { useCallback, useState } from 'react'
import { useUrlPreview } from './useUrlPreview'
import type { HoverUrlSource } from '../components/types'

export type HoverMatchState = {
  url: string
  urls: string[]
  source: HoverUrlSource | null
}

function sameHoverUrls(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((url, index) => url === b[index])
}

/**
 * Owns the cross-dashboard hover-match state (which url/source is being hovered
 * and the related urls to highlight) together with the url preview it drives.
 * `clearHoverUrlNow` is stable so it can be used as an effect dependency.
 */
export function useHoverMatch() {
  const { urlPreview, setUrlPreview, clearUrlPreviewNow } = useUrlPreview()
  const [hoverMatch, setHoverMatch] = useState<HoverMatchState>({ url: '', urls: [], source: null })

  function handleHoverUrlChange(url: string, source: HoverUrlSource = 'chip', matchUrls?: readonly string[]) {
    const nextUrl = url || ''
    const nextUrls = nextUrl
      ? [...new Set((matchUrls && matchUrls.length > 0 ? matchUrls : [nextUrl]).filter(Boolean))]
      : []
    const nextSource = nextUrls.length > 0 ? source : null
    setHoverMatch((current) => (
      current.url === nextUrl && current.source === nextSource && sameHoverUrls(current.urls, nextUrls)
        ? current
        : { url: nextUrl, urls: nextUrls, source: nextSource }
    ))
    setUrlPreview(nextUrl)
  }

  const clearHoverUrlNow = useCallback(function clearHoverUrlNow() {
    setHoverMatch((current) => (current.url || current.urls.length > 0 || current.source ? { url: '', urls: [], source: null } : current))
    clearUrlPreviewNow()
  }, [clearUrlPreviewNow])

  return { hoverMatch, urlPreview, handleHoverUrlChange, clearHoverUrlNow }
}
