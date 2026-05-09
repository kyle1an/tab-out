import { useEffect, useRef } from 'react'
import { HeaderStats } from './HeaderStats'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from './ui/tabs'
import { HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from '../extension/history-source.js'
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

function isHistoryRangeValue(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_RANGE_OPTIONS.some((option) => option.value === value)
}

function HistoryRangeSelect({
  value,
  onValueChange
}: {
  value: string
  onValueChange?: (historyRange: string) => void
}) {
  function handleValueChange(nextValue: unknown) {
    if (!isHistoryRangeValue(nextValue)) return
    if (nextValue === value) return
    onValueChange?.(nextValue)
  }

  return (
    <Select value={value} items={HISTORY_RANGE_OPTIONS} onValueChange={handleValueChange}>
      <SelectTrigger
        size="header"
        className="border-[var(--warm-gray)] bg-[rgba(115,115,115,0.06)] text-[length:var(--header-control-font-size)] leading-[var(--header-control-line-height)]"
        aria-label="History search range"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent size="header">
        <SelectGroup>
          {HISTORY_RANGE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

interface HeaderBarProps extends DashboardStats {
  filter: string
  filterFocusRequest?: number
  historyRange: string
  showHistoryRange?: boolean
  onFilterChange: (filter: string) => void
  onHistoryRangeChange?: (historyRange: string) => void
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
      className="source-switch-root inline-flex box-border h-[var(--header-control-height)] rounded-[var(--header-control-radius)] border border-[var(--warm-gray)] [corner-shape:squircle]"
      value={source}
      onValueChange={handleSourceChange}
    >
      <TabsList
        variant="unstyled"
        className="source-switch relative z-0 flex h-full box-border items-center gap-1 px-1 py-0"
        aria-label="Dashboard source"
      >
        {SOURCE_SWITCH_OPTIONS.map((option) => (
          <TabsTrigger
            key={option.value}
            variant="unstyled"
            className="source-switch-option relative z-1 inline-flex h-8 box-border cursor-pointer select-none items-center justify-center whitespace-nowrap border-0 bg-transparent px-2 py-0 text-[length:var(--header-control-font-size)] leading-[var(--header-control-line-height)] font-normal text-tab-muted outline-none [font-family:inherit] [transition:color_0.15s_ease] before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:rounded-[calc(var(--header-control-radius)_-_6px)] before:outline-2 before:-outline-offset-1 before:outline-transparent before:[corner-shape:squircle] before:content-[''] hover:text-tab-ink focus-visible:outline-none focus-visible:before:outline-[var(--accent-amber)] data-[active]:text-tab-ink"
            value={option.value}
          >
            {option.label}
          </TabsTrigger>
        ))}
        <TabsIndicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-[var(--active-tab-width)] rounded-[calc(var(--header-control-radius)_-_6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] [transform:translateX(var(--active-tab-left))_translateY(-50%)] [transition:width_0.2s_ease-in-out,transform_0.2s_ease-in-out]" />
      </TabsList>
    </Tabs>
  )
}

export function HeaderBar({
  filter,
  filterFocusRequest = 0,
  historyRange,
  showHistoryRange = false,
  onFilterChange,
  onHistoryRangeChange,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  source = 'tabs',
  ready = true,
  ...stats
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
        <HeaderStats
          source={source}
          ready={ready}
          totalTabs={stats.totalTabs}
          visibleTabs={stats.visibleTabs}
          totalWindows={stats.totalWindows}
          visibleWindows={stats.visibleWindows}
          totalDomains={stats.totalDomains}
          visibleDomains={stats.visibleDomains}
          dedupCount={stats.dedupCount}
          filteredCloseCount={stats.filteredCloseCount}
          hasCards={stats.hasCards}
          filtering={stats.filtering}
          onDedupAll={onDedupAll}
          onCloseFiltered={onCloseFiltered}
        />
        <div className="header-controls inline-flex items-center gap-2.5">
          <SourceSwitch source={source} onSourceChange={onSourceChange} />
          {showHistoryRange && (
            <HistoryRangeSelect
              value={historyRange}
              onValueChange={(nextRange) => onHistoryRangeChange?.(nextRange)}
            />
          )}
          <div className={cn('tab-filter-wrap relative inline-flex items-center', filter && 'has-value [&_.tab-filter]:pr-[30px] [&_.tab-filter-clear]:inline-flex')}>
            <Input
              ref={inputRef}
              type="search"
              className="tab-filter box-border h-[var(--header-control-height)] w-[280px] rounded-[var(--header-control-radius)] border border-[var(--warm-gray)] bg-[rgba(115,115,115,0.06)] px-3.5 py-0 text-[length:var(--header-control-font-size)] leading-[var(--header-control-line-height)] text-[var(--ink)] outline-none [font-family:inherit] [transition:border-color_0.15s,background_0.15s,opacity_0.2s] [corner-shape:squircle] placeholder:select-none placeholder:text-[var(--muted)] focus:border-[var(--accent-amber)] focus:bg-tab-card [&::-webkit-search-cancel-button]:[-webkit-appearance:none]"
              autoComplete="off"
              spellCheck="false"
              placeholder={filterPlaceholder}
              value={filter}
              onChange={(e) => updateFilter(e.currentTarget.value)}
            />
            <Button
              variant="unstyled"
              size="unstyled"
              className="tab-filter-clear absolute top-1/2 right-1.5 hidden h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-tab-muted transition-[background,color] duration-150 ease-[ease] hover:bg-[rgba(10,10,10,0.08)] hover:text-tab-ink [&_svg]:h-3 [&_svg]:w-3"
              title="Clear filter"
              aria-label="Clear filter"
              onClick={onClear}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </header>
  )
}
