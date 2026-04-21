/* ================================================================
   Live tab filter — listener layer + filter state.

   Previously this file contained ~200 lines of DOM mutation: walk
   every .page-chip, toggle style.display, recompute each section's
   visible count, rewrite the close-domain and dedup button labels,
   hide empty .pathgroup-section / .subdomain-section / .flat-section.

   That's all gone. The filter query now lives in a module-level
   var; every component reads it through computeDomainCardViewModel
   (render.js), which narrows tabs → chips → sections. When the user
   types, we set the query and call mountMissions — Preact diffs the
   two card grids and updates the DOM. The filter works via the same
   render pipeline as tab-open / tab-close events, not a parallel
   post-render walk.

   What this file still does:
     • holds the filter query (state)
     • wires every user input that should update it (debounced input,
       Esc, ✕ clear button, type-to-filter, paste-to-filter)
     • manages the input's placeholder / dim state across window
       focus / input focus
     • keeps .tab-filter-wrap's `.has-value` class in sync so the ✕
       button shows/hides via CSS
   ================================================================ */

import { mountMissions } from './render.js'

// Filter state. Kept as a module-level var rather than a DOM read
// so computeDomainCardViewModel can access the current query without
// touching the input element (avoids coupling render to the DOM).
let filterQuery = ''

export function getFilter() {
  return filterQuery
}

export function applyTabFilter(query) {
  filterQuery = (query || '').trim().toLowerCase()
  mountMissions()
}

// Placeholder lives in index.html and stays constant across all
// focus states — the focus outline already communicates input vs.
// idle, so swapping the text adds visual chatter without new info.
// Two classes still carry state-dependent visuals though:
//   • .capture-ready — window focused, input isn't. Subtle "keystrokes
//                      will route here" cue for the type-anywhere path.
//   • .capture-dormant — window blurred. Dims the input to signal
//                      "keystrokes can't arrive right now."
// Page-blurred-but-input-focused is folded into 'idle' — the dim
// should win whenever the window can't receive input, regardless of
// what activeElement technically is.
function computeFilterState(pageFocused, inputFocused) {
  if (!pageFocused) return 'idle'
  return inputFocused ? 'edit' : 'hint'
}

function applyFilterPlaceholder() {
  const input = document.getElementById('tabFilter')
  if (!input) return
  const state = computeFilterState(document.hasFocus(), document.activeElement === input)
  input.classList.toggle('capture-ready', state === 'hint')
  input.classList.toggle('capture-dormant', state === 'idle')
}

/** Sync the wrapper's `.has-value` class to the input's current value so
 *  the ✕ clear button CSS can toggle visibility without JS on each
 *  frame. Called from every code path that mutates input.value. */
function syncFilterWrapClass(input) {
  const wrap = input && input.closest ? input.closest('.tab-filter-wrap') : null
  if (wrap) wrap.classList.toggle('has-value', input.value.length > 0)
}

let filterTimer = null

// Debounced input on the filter field
document.addEventListener('input', (e) => {
  if (e.target.id !== 'tabFilter') return
  syncFilterWrapClass(e.target)
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => applyTabFilter(e.target.value), 80)
})

// Clear button (✕) inside the filter wrapper. One-shot reset: blanks
// the input, re-applies the empty filter (which restores every card),
// and leaves the input focused so the user can immediately type a
// new query.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tab-filter-clear')) return
  const input = document.getElementById('tabFilter')
  if (!input) return
  input.value = ''
  syncFilterWrapClass(input)
  applyTabFilter('')
  input.focus()
})

// Esc clears the filter while it's focused — quick escape hatch.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const input = document.getElementById('tabFilter')
  if (!input || document.activeElement !== input) return
  if (input.value !== '') {
    input.value = ''
    syncFilterWrapClass(input)
    applyTabFilter('')
  } else {
    input.blur()
  }
})

// Keep the placeholder in sync with both window-level focus and
// input-level focus — three states (IDLE / HINT / EDIT) need two
// signal sources.
window.addEventListener('focus', applyFilterPlaceholder)
window.addEventListener('blur', applyFilterPlaceholder)
{
  const tabFilter = document.getElementById('tabFilter')
  if (tabFilter) {
    tabFilter.addEventListener('focus', applyFilterPlaceholder)
    tabFilter.addEventListener('blur', applyFilterPlaceholder)
  }
}
applyFilterPlaceholder()

// Type-to-filter: when the user starts typing anywhere (no modifier,
// not already in an input), auto-focus the filter and pipe the
// keystroke in. Mirrors Slack / Linear / GitHub.
// Also handles Backspace/Delete so a type-anywhere correction works
// without the user having to click into the input first.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const a = document.activeElement
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
  const input = document.getElementById('tabFilter')
  if (!input) return

  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (input.value === '') return
    e.preventDefault()
    input.value = input.value.slice(0, -1)
    syncFilterWrapClass(input)
    input.focus()
    applyTabFilter(input.value)
    return
  }

  if (e.key.length !== 1) return
  e.preventDefault()
  input.focus()
  input.value += e.key
  syncFilterWrapClass(input)
  applyTabFilter(input.value)
})

// Paste-to-filter: Cmd/Ctrl+V anywhere on the page routes into the
// filter input. A dedicated paste listener catches the action
// regardless of which shortcut triggered it (menu, keyboard, or
// right-click paste).
document.addEventListener('paste', (e) => {
  const a = document.activeElement
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
  const input = document.getElementById('tabFilter')
  if (!input) return
  const text = e.clipboardData?.getData('text')
  if (!text) return
  e.preventDefault()
  input.focus()
  input.value += text
  syncFilterWrapClass(input)
  applyTabFilter(input.value)
})
