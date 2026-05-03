interface UrlPreviewProps {
  url: string
  visible?: boolean
}

export function UrlPreview({ url, visible = !!url }: UrlPreviewProps) {
  const isVisible = visible && !!url
  const className = 'url-preview' + (isVisible ? ' visible' : '')

  return (
    <div className={className} aria-hidden={isVisible ? 'false' : 'true'}>
      <span>{url || ''}</span>
    </div>
  )
}
