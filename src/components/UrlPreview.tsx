import { cn } from '@/lib/utils'

interface UrlPreviewProps {
  url: string
  visible?: boolean
}

export function UrlPreview({ url, visible = !!url }: UrlPreviewProps) {
  const isVisible = visible && !!url

  return (
    <div
      className={cn(
        'url-preview pointer-events-none fixed bottom-0 left-0 z-100 box-border flex h-7 max-w-[calc(100vw-32px)] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-tr-md border border-(--warm-gray) bg-tab-card px-2 font-sans text-[13px] leading-4 text-tab-ink opacity-0 shadow-[0_-2px_8px_var(--shadow)] transition-opacity duration-120 ease-[ease] [border-bottom:0] [border-left:0] [corner-shape:squircle]',
        isVisible && 'opacity-100'
      )}
      aria-hidden={isVisible ? 'false' : 'true'}
    >
      <span className="block min-w-0 overflow-hidden text-ellipsis leading-4">{url || ''}</span>
    </div>
  )
}
