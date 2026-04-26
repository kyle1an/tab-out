import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useRef } from '../vendor/preact-hooks.mjs'
import { HeaderStats } from './HeaderStats.js'

const html = htm.bind(h)

function SourceSwitch({ source, onSourceChange }) {
  return html`
    <div class="source-switch" role="tablist" aria-label="Dashboard source">
      <button
        type="button"
        class=${'source-switch-option' + (source === 'tabs' ? ' is-active' : '')}
        aria-selected=${source === 'tabs' ? 'true' : 'false'}
        onClick=${() => onSourceChange('tabs')}
      >
        Tabs
      </button>
      <button
        type="button"
        class=${'source-switch-option' + (source === 'bookmarks' ? ' is-active' : '')}
        aria-selected=${source === 'bookmarks' ? 'true' : 'false'}
        onClick=${() => onSourceChange('bookmarks')}
      >
        Bookmarks
      </button>
    </div>
  `
}

export function isFilterFocusShortcut(e, platform = '') {
  if (!e || (e.key || '').toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  return isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
}

export function HeaderBar({ filter, filterFocusRequest = 0, onFilterChange, onCloseFiltered, onDedupAll, onSourceChange, source = 'tabs', ready = true, ...stats }) {
  const inputRef = useRef(null)

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
  const filterPlaceholder = source === 'bookmarks' ? 'Filter bookmarks…' : 'Filter tabs, bookmarks…'

  function onClear() {
    updateFilter('')
    inputRef.current?.focus()
  }

  return html`
    <header>
      <div class="header-row">
        <${HeaderStats}
          source=${source}
          ready=${ready}
          totalTabs=${stats.totalTabs}
          visibleTabs=${stats.visibleTabs}
          totalWindows=${stats.totalWindows}
          visibleWindows=${stats.visibleWindows}
          totalDomains=${stats.totalDomains}
          visibleDomains=${stats.visibleDomains}
          dedupCount=${stats.dedupCount}
          filteredCloseCount=${stats.filteredCloseCount}
          hasCards=${stats.hasCards}
          filtering=${stats.filtering}
          onDedupAll=${onDedupAll}
          onCloseFiltered=${onCloseFiltered}
        />
        <div class="header-controls">
          <${SourceSwitch} source=${source} onSourceChange=${onSourceChange} />
          <div class=${wrapClass}>
            <input
              ref=${inputRef}
              type="search"
              class="tab-filter"
              autocomplete="off"
              spellcheck="false"
              placeholder=${filterPlaceholder}
              value=${filter}
              onInput=${(e) => updateFilter(e.currentTarget.value)}
            />
            <button class="tab-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" onClick=${onClear}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  `
}
