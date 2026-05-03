import { useEffect, useRef } from 'react'
import { HeaderStats } from './HeaderStats'
import { HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from '../../extension/history-source.js'
import { isFilterFocusShortcut } from '../../extension/app-url.js'

function SourceSwitch({ source, onSourceChange }) {
  return (
    <div className="source-switch" role="tablist" aria-label="Dashboard source">
      <button
        type="button"
        className={'source-switch-option' + (source === 'tabs' ? ' is-active' : '')}
        aria-selected={source === 'tabs' ? 'true' : 'false'}
        onClick={() => onSourceChange('tabs')}
      >
        Tabs
      </button>
      <button
        type="button"
        className={'source-switch-option' + (source === 'bookmarks' ? ' is-active' : '')}
        aria-selected={source === 'bookmarks' ? 'true' : 'false'}
        onClick={() => onSourceChange('bookmarks')}
      >
        Bookmarks
      </button>
    </div>
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
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  function updateFilter(nextValue) {
    onFilterChange(nextValue)
  }

  useEffect(() => {
    if (filterFocusRequest <= 0) return
    inputRef.current?.focus()
  }, [filterFocusRequest])

  useEffect(() => {
    function onWindowKeyDown(e) {
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
            <select className="history-range-select" aria-label="History search range" value={historyRange} onChange={(e) => onHistoryRangeChange?.(e.currentTarget.value)}>
              {HISTORY_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <div className={wrapClass}>
            <input
              ref={inputRef}
              type="search"
              className="tab-filter"
              autoComplete="off"
              spellCheck="false"
              placeholder={filterPlaceholder}
              value={filter}
              onInput={(e) => updateFilter(e.currentTarget.value)}
            />
            <button className="tab-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" onClick={onClear}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
