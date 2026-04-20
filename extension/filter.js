/* ================================================================
   Live tab filter

   • applyTabFilter(query) — hides chips/cards that don't match
   • Debounced input listener on #tabFilter
   • Esc to clear
   • Type-to-filter: typing anywhere on the page focuses the input
     and pipes the keystroke through (Slack/Linear/GitHub style)
   ================================================================ */

import { packMissionsMasonry } from './layout.js'
import { domainGroups, updateTabCountDisplays, updateSectionCount, updateFilteredActions, ICONS } from './render.js'
import { isGroupedTab } from './groups.js'

// Three placeholder states, so the hint always reflects reality:
//   • IDLE — window lacks focus. Text is redundant since the dim
//            visual already signals "can't receive keys" — cleaner
//            to leave the input blank.
//   • HINT — window has focus, input doesn't (type-anywhere is live)
//   • EDIT — input is focused (the type-anywhere hint is redundant;
//            swap in something informational about what gets matched)
const PLACEHOLDER_IDLE = ''
const PLACEHOLDER_HINT = 'Type anywhere to filter…'
const PLACEHOLDER_EDIT = 'Title or URL…'

// Three named states collapse the (pageFocused, inputFocused) matrix:
//   • 'idle' — window lacks focus. Keystrokes never arrive. Dimmed.
//   • 'hint' — window focused, input isn't. Type-anywhere is live.
//   • 'edit' — input itself has focus. Normal editing UI.
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

  input.placeholder = state === 'edit' ? PLACEHOLDER_EDIT : state === 'hint' ? PLACEHOLDER_HINT : PLACEHOLDER_IDLE
  // `.capture-ready` gives the input a subtler pre-focus look so the user
  // trusts keystrokes will land here even before clicking in.
  input.classList.toggle('capture-ready', state === 'hint')
  // `.capture-dormant` dims the input when the window lacks focus —
  // a visual "this can't respond to keys right now" cue that reads
  // faster than the placeholder text alone.
  input.classList.toggle('capture-dormant', state === 'idle')
}

/**
 * applyTabFilter(query) — hide non-matching chips inside matched cards,
 * and mark cards with no matches as `.card-unmatched` so masonry demotes
 * them to the "Other tabs" group below the divider. Unmatched cards
 * keep all their chips visible (context) but have filter-scoped action
 * buttons (close-domain, dedup) hidden to prevent accidental bulk
 * actions on content the user didn't filter for. While filtering, the
 * "+N more" overflow container is force-opened inside matched cards so
 * a matching hidden chip isn't left invisible. Empty query restores the
 * default view.
 */
/**
 * Per-card counts + button labels that reflect the active filter. Shared
 * with no filter case (matchingTabs === group.tabs), so the same pass
 * also restores original labels when the filter is cleared.
 */
function updateCardStats(card, group, filtering, q) {
  const matchingTabs = filtering ? group.tabs.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)) : group.tabs
  const closableTabs = matchingTabs.filter((t) => !isGroupedTab(t))

  // Tab count badge (skip app-badge — has its own format)
  const tabBadge = card.querySelector('.tab-count-badge:not(.app-badge)')
  if (tabBadge) {
    tabBadge.textContent = String(matchingTabs.length)
    tabBadge.title = `${matchingTabs.length} open tab${matchingTabs.length !== 1 ? 's' : ''}`
  }

  // Close-domain button (top-right corner of card)
  const closeBtn = card.querySelector('.card-close-btn')
  if (closeBtn) {
    if (closableTabs.length === 0) {
      closeBtn.style.display = 'none'
    } else {
      closeBtn.style.display = ''
      const label =
        closableTabs.length === matchingTabs.length
          ? `Close all ${closableTabs.length} tab${closableTabs.length !== 1 ? 's' : ''}`
          : `Close ${closableTabs.length} ungrouped tab${closableTabs.length !== 1 ? 's' : ''}`
      const textSpan = closeBtn.querySelector('.card-close-btn-text')
      if (textSpan) textSpan.textContent = label
    }
  }

  // Dedup button — recompute the 4-case policy on matching tabs only
  const dupeInfo = {}
  const urlCounts = {}
  for (const tab of matchingTabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1
    if (!dupeInfo[tab.url]) dupeInfo[tab.url] = { total: 0, ungrouped: 0, groupIds: new Set() }
    const info = dupeInfo[tab.url]
    info.total++
    if (isGroupedTab(tab)) info.groupIds.add(tab.groupId)
    else info.ungrouped++
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1)
  const closableForUrl = (u) => {
    const info = dupeInfo[u]
    if (!info) return 0
    const grouped = info.total - info.ungrouped
    if (grouped >= 1 && info.ungrouped >= 1) return info.ungrouped
    if (grouped === 0 && info.ungrouped >= 2) return info.ungrouped - 1
    if (grouped >= 2 && info.groupIds.size === 1) return info.total - 1
    return 0
  }
  const closableDupeUrls = dupeUrls.map(([u]) => u).filter((u) => closableForUrl(u) > 0)
  const closableExtras = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0)

  const dedupBtn = card.querySelector('[data-action="dedup-keep-one"]')
  if (dedupBtn) {
    if (closableExtras === 0) {
      dedupBtn.style.display = 'none'
    } else {
      dedupBtn.style.display = ''
      dedupBtn.textContent = `Close ${closableExtras} duplicate${closableExtras !== 1 ? 's' : ''}`
      dedupBtn.dataset.dupeUrls = closableDupeUrls.map(encodeURIComponent).join(',')
    }
  }
}

/**
 * chipMatches(chip, q) — does this chip match the (already lowercased)
 * filter query? Checks the chip's display text and its tab URL.
 * Strips U+200B that render.js:injectBreakPoints inserts into long
 * tokens for line-wrap control — otherwise a filter like
 * "alicebobacme" would miss "alice\u200Bbobac\u200B…".
 */
function chipMatches(chip, q) {
  const text = chip.textContent.replace(/\u200B/g, '').toLowerCase()
  const url = (chip.dataset.tabUrl || '').toLowerCase()
  return text.includes(q) || url.includes(q)
}

/** Unmatched card: show all chips + restore original tab count badge.
 *  Explicitly hide filter-scoped action buttons so the user can't
 *  accidentally trigger a bulk close/dedup on content they didn't
 *  filter for (they typed "github" — closing unrelated reddit tabs
 *  would be a surprise). */
function styleUnmatchedCard(card, group) {
  const chips = card.querySelectorAll('.page-chip[data-action="focus-tab"]')
  chips.forEach((chip) => {
    chip.style.display = ''
  })

  const tabBadge = card.querySelector('.tab-count-badge:not(.app-badge)')
  if (tabBadge) {
    tabBadge.textContent = String(group.tabs.length)
    tabBadge.title = `${group.tabs.length} open tab${group.tabs.length !== 1 ? 's' : ''}`
  }

  const closeBtn = card.querySelector('.card-close-btn')
  if (closeBtn) closeBtn.style.display = 'none'
  const dedupBtn = card.querySelector('[data-action="dedup-keep-one"]')
  if (dedupBtn) dedupBtn.style.display = 'none'
}

export function applyTabFilter(query) {
  const q = (query || '').trim().toLowerCase()
  const filtering = q.length > 0
  const container = document.getElementById('openTabsMissions')
  if (!container) return

  container.querySelectorAll('.mission-card').forEach((card) => {
    const chips = card.querySelectorAll('.page-chip[data-action="focus-tab"]')
    // Multiple overflow containers + "+N more" buttons per card now —
    // one per subdomain section. All need to be force-opened/hidden
    // uniformly inside matched cards while filtering is active.
    const overflows = card.querySelectorAll('.page-chips-overflow')
    const moreBtns = card.querySelectorAll('.page-chip-overflow')

    let anyMatch = false
    if (filtering) {
      chips.forEach((chip) => {
        if (chipMatches(chip, q)) anyMatch = true
      })
    } else {
      anyMatch = true
    }

    const cardUnmatched = filtering && !anyMatch
    card.classList.toggle('card-unmatched', cardUnmatched)
    // Cards are never display:none'd anymore — unmatched ones are
    // demoted to the "Other tabs" section via the class + two-pass
    // masonry pack, not hidden.
    card.style.display = ''

    const domainId = card.dataset.domainId
    const group = domainGroups.find((g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId)

    if (cardUnmatched) {
      overflows.forEach((overflow) => {
        if (overflow.dataset.preFilter !== undefined) {
          overflow.style.display = overflow.dataset.preFilter
          delete overflow.dataset.preFilter
        }
      })
      moreBtns.forEach((btn) => {
        btn.style.display = ''
      })
      if (group) styleUnmatchedCard(card, group)
      return
    }

    chips.forEach((chip) => {
      if (!filtering) {
        chip.style.display = ''
        return
      }
      chip.style.display = chipMatches(chip, q) ? '' : 'none'
    })

    overflows.forEach((overflow) => {
      if (filtering) {
        if (overflow.dataset.preFilter === undefined) {
          overflow.dataset.preFilter = overflow.style.display || ''
        }
        overflow.style.display = 'contents'
      } else if (overflow.dataset.preFilter !== undefined) {
        overflow.style.display = overflow.dataset.preFilter
        delete overflow.dataset.preFilter
      }
    })
    moreBtns.forEach((btn) => {
      btn.style.display = filtering ? 'none' : ''
    })

    if (group) updateCardStats(card, group, filtering, q)
  })

  packMissionsMasonry({ unpin: true })
  updateTabCountDisplays()
  updateSectionCount()
  updateFilteredActions()
}

let filterTimer = null

/* ---- Listeners — set up once at module load ---- */

// Debounced input on the filter field
document.addEventListener('input', (e) => {
  if (e.target.id !== 'tabFilter') return
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => applyTabFilter(e.target.value), 80)
})

// Esc clears the filter while it's focused — quick escape hatch.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const input = document.getElementById('tabFilter')
  if (!input || document.activeElement !== input) return
  if (input.value !== '') {
    input.value = ''
    applyTabFilter('')
  } else {
    input.blur()
  }
})

// Keep the placeholder in sync with both window-level focus and
// input-level focus — three states (IDLE / HINT / EDIT) need two
// signal sources. The state cache inside applyFilterPlaceholder()
// makes redundant event bursts a no-op, so the handler is safe to
// attach directly without a debounce wrapper.
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
// Also handles Backspace/Delete so the user can correct a filter they
// typed via type-anywhere without having to click into the input
// first — otherwise the "type anywhere" promise is only half true.
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
    input.focus()
    applyTabFilter(input.value)
    return
  }

  if (e.key.length !== 1) return
  e.preventDefault()
  input.focus()
  input.value += e.key
  applyTabFilter(input.value)
})

// Paste-to-filter: Cmd/Ctrl+V anywhere on the page routes into the
// filter input. A dedicated `paste` listener is cleaner than special-
// casing the keydown handler above — it catches the actual paste
// action regardless of which shortcut triggered it (menu, keyboard,
// or right-click paste from the future).
document.addEventListener('paste', (e) => {
  const a = document.activeElement
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return
  const input = document.getElementById('tabFilter')
  if (!input) return
  // Spec says clipboardData is populated for paste events, but some
  // synthetic/programmatic paths can dispatch one without it — guard
  // with optional chaining so a null doesn't throw.
  const text = e.clipboardData?.getData('text')
  if (!text) return
  e.preventDefault()
  input.focus()
  input.value += text
  applyTabFilter(input.value)
})
