import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { fetchWorkingSetSnapshot, focusWorkingSetItem } from '../extension/working-set-client.js'
import type { HoverUrlChangeHandler, TabsChangeHandler } from './types'
import type { WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import { cn } from '@/lib/utils'

interface WorkingSetPanelProps {
  snapshot: WorkingSetSnapshot | null
  onHoverUrlChange?: HoverUrlChangeHandler
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
}

function WorkingSetItemButton({ item, onHoverUrlChange, onSnapshotChange, onTabsChange }: {
  item: WorkingSetItem
  onHoverUrlChange?: HoverUrlChangeHandler
  onSnapshotChange?: (snapshot: WorkingSetSnapshot) => void
  onTabsChange?: TabsChangeHandler
}) {
  async function onClick() {
    const focused = await focusWorkingSetItem(item)
    if (!focused) return
    onSnapshotChange?.(await fetchWorkingSetSnapshot())
    await onTabsChange?.()
  }

  function onMouseEnter() {
    onHoverUrlChange?.(item.tabUrl, 'chip', [item.tabUrl, item.rawUrl])
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  return (
    <button
      type="button"
      className={cn(
        'working-set-item group/working-set-item relative flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--warm-gray)] bg-tab-card px-2 py-1.5 text-left text-[13px] leading-tight text-tab-ink outline-none [corner-shape:squircle] transition-[border-color,background,box-shadow] duration-100 hover:border-[var(--accent-amber)] hover:bg-[rgba(82,82,82,0.08)] focus-visible:border-[var(--accent-amber)] focus-visible:ring-2 focus-visible:ring-[rgba(234,179,8,0.28)]',
        item.active && 'border-transparent bg-neutral-100 shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400'
      )}
      title={item.title}
      aria-label={`Switch to ${item.title}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <span className={cn('grid h-4 w-4 flex-none place-items-center', !item.faviconUrl && 'invisible')}>
        {item.faviconUrl && <img className="block h-full w-full object-contain" src={item.faviconUrl} alt="" />}
      </span>
      <span className="flex min-w-0 flex-auto flex-col gap-0.5">
        <span className="working-set-title block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-tab-ink">
          {item.title}
        </span>
        <span className="working-set-url block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-tab-muted">
          {item.displayUrl}
        </span>
      </span>
      {item.dupeCount > 1 && (
        <span className="working-set-dupe-badge inline-flex h-4 min-w-5 flex-none items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] px-1 text-[10px] font-semibold tabular-nums text-tab-muted">
          ×{item.dupeCount}
        </span>
      )}
    </button>
  )
}

export function WorkingSetPanel({ snapshot, onHoverUrlChange, onSnapshotChange, onTabsChange }: WorkingSetPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const items = snapshot?.items || []
  if (items.length === 0) return null

  const defaultLimit = snapshot?.defaultLimit || 8
  const expandedLimit = snapshot?.expandedLimit || 16
  const visibleLimit = expanded ? expandedLimit : defaultLimit
  const visibleItems = items.slice(0, visibleLimit)
  const hasMore = items.length > defaultLimit

  return (
    <section className="working-set-panel mb-4 min-w-0" aria-label="Working set">
      <div className="working-set-panel-header mb-2 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="m-0 text-xs font-semibold tracking-[0.6px] text-tab-muted uppercase">Working set</h2>
          <span className="text-[11px] tabular-nums text-tab-muted opacity-70">{items.length}</span>
        </div>
        {hasMore && (
          <button
            type="button"
            className="working-set-toggle inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-[var(--warm-gray)] bg-transparent px-2 text-xs font-medium text-tab-muted [corner-shape:squircle] hover:bg-[rgba(82,82,82,0.08)] focus-visible:border-[var(--accent-amber)] focus-visible:outline-none"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
      <div className="working-set-grid grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5 max-[560px]:grid-cols-1">
        {visibleItems.map((item) => (
          <WorkingSetItemButton
            key={item.key}
            item={item}
            onHoverUrlChange={onHoverUrlChange}
            onSnapshotChange={onSnapshotChange}
            onTabsChange={onTabsChange}
          />
        ))}
      </div>
    </section>
  )
}
