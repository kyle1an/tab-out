import { useState, type ImgHTMLAttributes } from 'react'

type FaviconImageProps = ImgHTMLAttributes<HTMLImageElement>

/**
 * Hide one failed favicon without mutating a reusable DOM node globally.
 * When Chrome supplies a different source, the component renders a fresh
 * image attempt and the new icon can recover normally.
 */
export function FaviconImage({ src, alt = '', onError, ...props }: FaviconImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (!src || failedSrc === src) return null

  return (
    <img
      {...props}
      alt={alt}
      src={src}
      onError={(event) => {
        setFailedSrc(src)
        onError?.(event)
      }}
    />
  )
}
