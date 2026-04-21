import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useRef, useState } from '../vendor/preact-hooks.mjs'
import { HeaderStats } from './HeaderStats.js'

const html = htm.bind(h)

function isTextField(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function HeaderBar({ filter, onFilterChange, onCloseFiltered, onDedupAll, ready = true, ...stats }) {
  const inputRef = useRef(null)
  const filterRef = useRef(filter)
  const [pageFocused, setPageFocused] = useState(document.hasFocus())
  const [inputFocused, setInputFocused] = useState(false)

  filterRef.current = filter

  function updateFilter(nextValue) {
    filterRef.current = nextValue
    onFilterChange(nextValue)
  }

  useEffect(() => {
    const onWindowFocus = () => setPageFocused(true)
    const onWindowBlur = () => setPageFocused(false)

    function onEscape(e) {
      if (e.defaultPrevented || e.key !== 'Escape') return
      const input = inputRef.current
      if (!input || document.activeElement !== input) return
      if (filterRef.current !== '') updateFilter('')
      else input.blur()
    }

    function onTypeAnywhere(e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTextField(document.activeElement)) return
      const input = inputRef.current
      if (!input) return

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (filterRef.current === '') return
        e.preventDefault()
        input.focus()
        updateFilter(filterRef.current.slice(0, -1))
        return
      }

      if (e.key.length !== 1) return
      e.preventDefault()
      input.focus()
      updateFilter(filterRef.current + e.key)
    }

    function onPasteAnywhere(e) {
      if (e.defaultPrevented || isTextField(document.activeElement)) return
      const input = inputRef.current
      const text = e.clipboardData?.getData('text')
      if (!input || !text) return
      e.preventDefault()
      input.focus()
      updateFilter(filterRef.current + text)
    }

    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('keydown', onEscape)
    document.addEventListener('keydown', onTypeAnywhere)
    document.addEventListener('paste', onPasteAnywhere)
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('keydown', onEscape)
      document.removeEventListener('keydown', onTypeAnywhere)
      document.removeEventListener('paste', onPasteAnywhere)
    }
  }, [onFilterChange])

  const filterStateClass = !pageFocused ? 'capture-dormant' : inputFocused ? '' : 'capture-ready'
  const filterClass = ['tab-filter', filterStateClass].filter(Boolean).join(' ')
  const wrapClass = 'tab-filter-wrap' + (filter ? ' has-value' : '')

  function onClear() {
    updateFilter('')
    inputRef.current?.focus()
  }

  return html`
    <header>
      <div class="header-row">
        <${HeaderStats}
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
        <div class=${wrapClass}>
          <input
            ref=${inputRef}
            type="search"
            class=${filterClass}
            autocomplete="off"
            spellcheck="false"
            placeholder="Type anywhere to filter…"
            value=${filter}
            onInput=${(e) => updateFilter(e.currentTarget.value)}
            onFocus=${() => setInputFocused(true)}
            onBlur=${() => setInputFocused(false)}
          />
          <button class="tab-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" onClick=${onClear}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  `
}
