import type { FilterFocusBootWindow } from './filter-focus-buffer.js'

const bootWindow = window as FilterFocusBootWindow
const params = new URLSearchParams(window.location.search)
const input = document.querySelector<HTMLInputElement>(
  '[data-tabout="filter-query"] [data-tabout-part="input"]',
)
const shouldFocus = params.get('focusFilter') === '1'

if ((shouldFocus || params.has('filter')) && input) {
  const recordInput = () => {
    bootWindow.__tabOutFilterFocusBootValue = input.value
  }
  input.value = params.get('filter') || ''
  recordInput()
  input.addEventListener('input', recordInput)
  bootWindow.__tabOutReleaseFilterFocusBoot = () => {
    input.removeEventListener('input', recordInput)
  }
  if (shouldFocus) input.focus()
}
