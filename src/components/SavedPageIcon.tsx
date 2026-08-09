import { cn } from '@/lib/utils'

export function SavedPageIcon({ saved, className }: { saved: boolean, className: string }) {
  return <span aria-hidden="true" className={cn(saved ? 'icon-[mingcute--star-fill]' : 'icon-[mingcute--star-line]', className)} />
}
