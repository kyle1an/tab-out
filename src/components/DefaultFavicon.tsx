const DEFAULT_FAVICON_SRC = 'icons/chrome-default-favicon-16.png'

export function DefaultFavicon({ className = '' }: { className?: string }) {
  return (
    <img
      className={['default-favicon-image block h-full w-full object-contain', className].filter(Boolean).join(' ')}
      src={DEFAULT_FAVICON_SRC}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
