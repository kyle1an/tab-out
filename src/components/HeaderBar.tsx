import { useEffect, useRef } from 'react'
import { HeaderStats } from './HeaderStats'
import { Button } from './ui/Button'
import { SelectControl } from './ui/SelectControl'
import { SegmentedTabs } from './ui/SegmentedTabs'
import { TextInput } from './ui/TextInput'
import { HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from '../extension/history-source.js'
import { isFilterFocusShortcut } from '../extension/app-url.js'
import type { DashboardSource, DashboardStats } from './types'

interface SourceSwitchProps {
  source: DashboardSource
  onSourceChange: (source: DashboardSource) => void | Promise<void>
}

const SOURCE_SWITCH_OPTIONS = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'bookmarks', label: 'Bookmarks' }
] as const

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
  return (
    <SegmentedTabs
      rootClassName="source-switch-root"
      listClassName="source-switch"
      tabClassName="source-switch-option"
      value={source}
      options={SOURCE_SWITCH_OPTIONS}
      ariaLabel="Dashboard source"
      onValueChange={onSourceChange}
    />
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

  const wrapClass = 'tab-filter-wrap' + (filter ? ' has-value' : '')
  const filterPlaceholder = source === 'bookmarks' ? 'Filter bookmarks…' : isHistoryFilterEnabled(historyRange) ? 'Filter tabs, bookmarks, history…' : 'Filter tabs and bookmarks…'

  function onClear() {
    updateFilter('')
    inputRef.current?.focus()
  }

  return (
    <header>
      <div className="header-row">
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
        <div className="header-controls">
          <SourceSwitch source={source} onSourceChange={onSourceChange} />
          {showHistoryRange && (
            <SelectControl
              triggerClassName="history-range-select"
              positionerClassName="history-range-positioner"
              popupClassName="history-range-popup"
              listClassName="history-range-list"
              itemClassName="history-range-item"
              value={historyRange}
              options={HISTORY_RANGE_OPTIONS}
              ariaLabel="History search range"
              onValueChange={(nextRange) => onHistoryRangeChange?.(nextRange)}
            />
          )}
          <div className={wrapClass}>
            <TextInput
              ref={inputRef}
              type="search"
              className="tab-filter"
              autoComplete="off"
              spellCheck="false"
              placeholder={filterPlaceholder}
              value={filter}
              onValueChange={updateFilter}
            />
            <Button className="tab-filter-clear" title="Clear filter" aria-label="Clear filter" onClick={onClear}>
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
