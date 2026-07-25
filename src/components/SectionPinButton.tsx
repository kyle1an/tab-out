import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { MouseEvent } from 'react'

interface SectionPinButtonProps {
  pinned: boolean
  // Human-readable label of the section ("docs", "/document", "acme/repo")
  // — drives the tooltip and aria-label.
  label: string
  onClick: () => void | Promise<void>
  // Caller positions the button (inline vs absolute) and provides the
  // group-hover utility that reveals the unpinned icon on section hover
  // (e.g. "group-hover/website-path-section:opacity-100"). When pinned,
  // opacity is always 100 regardless of hover.
  className?: string
}

// One small icon button shared across the three section header components
// (subdomain, website-path, pathgroup). Mirrors the existing close-button
// pattern: hidden until the parent section is hovered, persistent when
// active. Visually lighter than the domain-card PinButton because section
// pins are an intra-card affordance, not a card-level one.
export function SectionPinButton({ pinned, label, onClick, className }: SectionPinButtonProps) {
  const title = `${pinned ? 'Unpin' : 'Pin'} ${label}`
  function onPinClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    void onClick()
  }
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        data-tabout-part="section-pin-button"
        className={cn(
          'section-pin-btn grid size-4.5 flex-[0_0_18px] cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 leading-0 transition-[opacity,background,color] duration-150 hover:bg-[#ededed] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
          pinned
            ? 'is-pinned opacity-100 text-foreground'
            : 'opacity-0 text-muted-foreground',
          className
        )}
        aria-label={title}
        aria-pressed={pinned ? 'true' : 'false'}
        onClick={onPinClick}
      >
        <svg className="block size-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
      </button>
    </TooltipAnchor>
  )
}
