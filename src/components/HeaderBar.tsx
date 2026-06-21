import { useEffect, useRef } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { HeaderStats } from './HeaderStats'
import { Input } from './ui/input'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { TooltipAnchor } from './ui/tooltip'
import { isHistoryFilterEnabled } from '../extension/history-range.js'
import { isFilterFocusShortcut } from '../extension/app-url.js'
import { cn } from '@/lib/utils'
import type { DashboardSource, DashboardStats } from './types'

interface SourceSwitchProps {
  source: DashboardSource
  onSourceChange: (source: DashboardSource) => void | Promise<void>
}

const SOURCE_SWITCH_OPTIONS = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'bookmarks', label: 'Bookmarks' }
] as const

function isSourceSwitchValue(value: unknown): value is DashboardSource {
  return typeof value === 'string' && SOURCE_SWITCH_OPTIONS.some((option) => option.value === value)
}

interface HeaderBarProps {
  stats: DashboardStats
  filter: string
  filterFocusRequest?: number
  historyRange: string
  onFilterChange: (filter: string) => void
  onCloseFiltered: () => void | Promise<void>
  onDedupAll: () => void | Promise<void>
  onSourceChange: (source: DashboardSource) => void | Promise<void>
  source?: DashboardSource
  ready?: boolean
}

function SourceSwitch({ source, onSourceChange }: SourceSwitchProps) {
  function handleSourceChange(nextValue: unknown) {
    if (!isSourceSwitchValue(nextValue)) return
    if (nextValue === source) return
    void onSourceChange(nextValue)
  }

  return (
    <Tabs
      data-tabout="source-switch"
      className="source-switch-root inline-flex box-border h-(--header-control-height) rounded-(--header-control-radius) border border-(--warm-gray) [corner-shape:squircle]"
      value={source}
      onValueChange={handleSourceChange}
    >
      <TabsList
        variant="line"
        className="source-switch relative z-0 flex h-full box-border items-center gap-1 rounded-none px-1 py-0"
        aria-label="Dashboard source"
      >
        {SOURCE_SWITCH_OPTIONS.map((option) => (
          <TabsTrigger
            key={option.value}
            data-tabout-part="source-option"
            className="source-switch-option relative z-1 inline-flex h-8 flex-none box-border cursor-pointer select-none items-center justify-center whitespace-nowrap border-0 bg-transparent px-2 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) font-normal text-tab-muted outline-none [font-family:inherit] [transition:color_0.15s_ease] after:hidden before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:rounded-[calc(var(--header-control-radius)_-_6px)] before:outline-2 before:-outline-offset-1 before:outline-transparent before:[corner-shape:squircle] before:content-[''] hover:text-tab-ink focus-visible:ring-0 focus-visible:outline-none focus-visible:before:outline-(--accent-amber) data-[active]:bg-transparent data-[active]:text-tab-ink data-[active]:shadow-none dark:data-[active]:border-transparent dark:data-[active]:bg-transparent"
            value={option.value}
          >
            {option.label}
          </TabsTrigger>
        ))}
        <TabsPrimitive.Indicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-(--active-tab-width) rounded-[calc(var(--header-control-radius)_-_6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] [transform:translateX(var(--active-tab-left))_translateY(-50%)] [transition:width_0.2s_ease-in-out,transform_0.2s_ease-in-out]" />
      </TabsList>
    </Tabs>
  )
}

export function HeaderBar({
  filter,
  filterFocusRequest = 0,
  historyRange,
  onFilterChange,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  source = 'tabs',
  ready = true,
  stats
}: HeaderBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  function updateFilter(nextValue: string) {
    onFilterChange(nextValue)
  }

  useEffect(() => {
    if (filterFocusRequest <= 0) return
    inputRef.current?.focus()
  }, [filterFocusRequest])

  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent) {
      if (!isFilterFocusShortcut(e, navigator.platform)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select?.()
    }

    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [])

  const filterPlaceholder = source === 'bookmarks' ? 'Filter bookmarks…' : isHistoryFilterEnabled(historyRange) ? 'Filter tabs, bookmarks, history…' : 'Filter tabs and bookmarks…'

  function onClear() {
    updateFilter('')
    inputRef.current?.focus()
  }

  return (
    <header className="flex flex-col">
      <div className="header-row flex items-center justify-between gap-4">
        <div className="header-left inline-flex items-center gap-2.5">
          <div
            data-tabout="filter-query"
            className={cn('tab-filter-wrap relative inline-flex items-center', filter && 'has-value [&_.tab-filter]:pr-[30px] [&_.tab-filter-clear]:inline-flex')}
          >
            <Input
              ref={inputRef}
              type="search"
              data-tabout-part="input"
              className="tab-filter box-border h-(--header-control-height) w-[280px] rounded-(--header-control-radius) border border-(--warm-gray) bg-[rgba(115,115,115,0.06)] px-3.5 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) text-(--ink) outline-none [font-family:inherit] [transition:border-color_0.15s,background_0.15s,opacity_0.2s] [corner-shape:squircle] placeholder:select-none placeholder:text-(--muted) focus:border-(--accent-amber) focus:bg-tab-card min-[900px]:max-[960px]:[.dashboard-shell.has-history_&]:w-[220px] [&::-webkit-search-cancel-button]:[-webkit-appearance:none]"
              autoComplete="off"
              spellCheck="false"
              placeholder={filterPlaceholder}
              value={filter}
              onChange={(e) => updateFilter(e.currentTarget.value)}
            />
            <TooltipAnchor content="Clear filter">
              <button
                type="button"
                data-tabout-part="clear-button"
                className="tab-filter-clear absolute top-1/2 right-1.5 hidden size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted transition-[background,color] duration-150 ease-[ease] hover:bg-[rgba(10,10,10,0.08)] hover:text-tab-ink [&_svg]:h-3 [&_svg]:w-3"
                aria-label="Clear filter"
                onClick={onClear}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </TooltipAnchor>
          </div>
          <HeaderStats
            source={source}
            ready={ready}
            {...stats}
            onDedupAll={onDedupAll}
            onCloseFiltered={onCloseFiltered}
          />
        </div>
        <div className="header-controls inline-flex items-center gap-2.5">
          <SourceSwitch source={source} onSourceChange={onSourceChange} />
        </div>
      </div>
    </header>
  )
}
