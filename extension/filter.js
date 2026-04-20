/* ================================================================
   Live tab filter

   • applyTabFilter(query) — hides chips/cards that don't match
   • Debounced input listener on #tabFilter
   • Esc to clear
   • Type-to-filter: typing anywhere on the page focuses the input
     and pipes the keystroke through (Slack/Linear/GitHub style)
   ================================================================ */

import { packMissionsMasonry } from './layout.js'
import { domainGroups, renderHeaderStats } from './render.js'
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
 * applyTabFilter(query) — split each domain card across two rendered
 * grids. Every card is rendered twice (by render.js): once into the
 * primary `#openTabsMissions` grid and once into the secondary
 * `#openTabsMissionsUnmatched` grid under the "Other tabs" divider.
 * This function sets the per-chip and per-card display for each copy
 * so that the same domain can appear in both places — matching chips
 * in the primary copy, non-matching chips in the secondary copy.
 *
 *   Primary copy:   show cards with ≥1 matching chip; hide non-matching
 *                   chips inside those cards; full-strength opacity.
 *   Secondary copy: show cards with ≥1 non-matching chip; hide matching
 *                   chips inside those cards; `.card-unmatched` class
 *                   dims the whole card, filter-scoped action buttons
 *                   stay hidden (typing "github" shouldn't expose a
 *                   bulk close for unrelated reddit tabs).
 *
 * While filtering, the "+N more" overflow container is force-opened in
 * both copies so every chip of interest is visible without expanding.
 * Empty query restores the default (one copy visible, the other grid's
 * wrapper hidden).
 */
/**
 * Per-card counts + button labels that reflect the active filter. Shared
 * with no filter case (matchingTabs === group.tabs), so the same pass
 * also restores original labels when the filter is cleared.
 */
function updateCardStats(card, group, filtering, q) {
  const matchingTabs = filtering ? group.tabs.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)) : group.tabs
  const closableTabs = matchingTabs.filter((t) => !isGroupedTab(t))

  // Tab count badge is owned by refreshCardAfterFilter so its value
  // reflects the VISIBLE chip count (not tab count) during filter —
  // updating it here would race and leave the wrong number on screen.

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

/** Style a card in the secondary ("Other tabs") grid. Hides every
 *  bulk-close button — close-domain, dedup, cluster-close,
 *  subdomain-close — so a user who typed "github" can't accidentally
 *  bulk-close matching tabs by clicking a button on the "other tabs"
 *  copy. Per-chip close (the `×` on each chip) stays active. */
function styleSecondaryCard(card) {
  card.querySelectorAll('.card-close-btn, [data-action="dedup-keep-one"], .pathgroup-close-btn, .subdomain-close-btn').forEach((btn) => {
    btn.style.display = 'none'
  })
}

/** Count chips in an element whose inline display isn't 'none'. Used
 *  for section visibility — a section with zero visible chips is
 *  collapsed even if the chips it contains each represent many tabs. */
function countVisibleChips(el) {
  const chips = el.querySelectorAll('.page-chip[data-action="focus-tab"]')
  let n = 0
  chips.forEach((c) => {
    if (c.style.display !== 'none') n++
  })
  return n
}

/** Sum the tab counts represented by currently-visible chips in `el`.
 *  Each chip carries `data-tab-count` set by PageChip — envs.length
 *  for folded chips, dupeCount for regular chips, else 1. Using this
 *  for header counts keeps the unit consistent with the unfiltered
 *  state (which always shows tab counts); counting chips instead
 *  would silently change the meaning of the number across states. */
function countVisibleTabs(el) {
  const chips = el.querySelectorAll('.page-chip[data-action="focus-tab"]')
  let n = 0
  chips.forEach((c) => {
    if (c.style.display === 'none') return
    n += parseInt(c.dataset.tabCount, 10) || 1
  })
  return n
}

/** After chip-level display toggles, walk the card's sub-section tree
 *  and reconcile the visible counts:
 *    • hide pathgroup / flat / subdomain sections that now have zero
 *      visible chips — otherwise their headers (cluster label, subdomain
 *      name) stay on-screen with nothing under them
 *    • update the pathgroup cluster count and subdomain count badges
 *      to reflect how many chips are visible in this section
 *    • set the card's tab-count badge to the card's total visible chip
 *      count so "filter matches N" reads directly off the card header
 *  Originals are read from `data-original-count` attributes that the
 *  Preact components set (and re-set on every live-sync render), so we
 *  always have a source-of-truth for "N when unfiltered" regardless of
 *  how many times the filter has been toggled.
 */
function refreshCardAfterFilter(card, filtering) {
  // Pathgroup cluster sections — header count + visibility. Chip
  // count drives visibility (hide when zero chips remain), tab count
  // drives the displayed number so the unit stays consistent with
  // the unfiltered state.
  card.querySelectorAll('.pathgroup-section').forEach((sec) => {
    const visibleChips = countVisibleChips(sec)
    const visibleTabs = countVisibleTabs(sec)
    const countEl = sec.querySelector('.pathgroup-header-count')
    if (countEl) {
      const original = countEl.dataset.originalCount || countEl.textContent || ''
      countEl.textContent = filtering ? String(visibleTabs) : original
    }
    sec.style.display = filtering && visibleChips === 0 ? 'none' : ''
  })

  // Flat singletons sections — no header count, just visibility
  card.querySelectorAll('.flat-section').forEach((sec) => {
    const visibleChips = countVisibleChips(sec)
    sec.style.display = filtering && visibleChips === 0 ? 'none' : ''
  })

  // Subdomain sections — header count + visibility. "Shared across
  // envs" is one of these; its folded chips each represent multiple
  // env tabs, so tab-count summing is load-bearing here specifically.
  card.querySelectorAll('.subdomain-section').forEach((sec) => {
    const visibleChips = countVisibleChips(sec)
    const visibleTabs = countVisibleTabs(sec)
    const countEl = sec.querySelector('.subdomain-header-count')
    if (countEl) {
      const original = countEl.dataset.originalCount || countEl.textContent || ''
      countEl.textContent = filtering ? String(visibleTabs) : original
    }
    sec.style.display = filtering && visibleChips === 0 ? 'none' : ''
  })

  // Card-level badge — tab count while filtering (sum of visible
  // chips' data-tab-count), view-model original otherwise. Skip app
  // badges (they carry their own "App · N" format).
  const tabBadge = card.querySelector('.tab-count-badge:not(.app-badge)')
  if (tabBadge) {
    const original = tabBadge.dataset.originalCount || tabBadge.textContent || ''
    if (filtering) {
      const visibleTabs = countVisibleTabs(card)
      tabBadge.textContent = String(visibleTabs)
      tabBadge.title = `${visibleTabs} tab${visibleTabs !== 1 ? 's' : ''} in this view`
    } else {
      tabBadge.textContent = original
      const n = parseInt(original, 10) || 0
      tabBadge.title = `${n} open tab${n !== 1 ? 's' : ''}`
    }
  }
}

/** Apply filter to one rendered grid. `mode` is either 'matched' (hide
 *  non-matching chips, show cards with ≥1 match) or 'unmatched' (hide
 *  matching chips, show cards with ≥1 non-match). Returns the number
 *  of visible cards in this grid after filtering so the caller can
 *  decide whether to show/hide the grid's wrapper. */
function filterGrid(containerId, q, filtering, mode) {
  const container = document.getElementById(containerId)
  if (!container) return 0
  let visibleCardCount = 0

  container.querySelectorAll('.mission-card').forEach((card) => {
    const chips = card.querySelectorAll('.page-chip[data-action="focus-tab"]')
    const overflows = card.querySelectorAll('.page-chips-overflow')
    const moreBtns = card.querySelectorAll('.page-chip-overflow')

    // Force all overflows open while filtering so hidden chips take
    // part in the visible set rather than staying tucked in a
    // collapsed "+N more" wrapper.
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

    // When filter is empty, primary shows everything and secondary
    // hides every card (its wrapper is hidden too, but zero out the
    // card display anyway so a flash of stale visibility doesn't
    // leak through if the wrapper is momentarily shown).
    if (!filtering) {
      chips.forEach((chip) => {
        chip.style.display = ''
      })
      if (mode === 'unmatched') {
        card.style.display = 'none'
        card.classList.remove('card-unmatched')
      } else {
        card.style.display = ''
        card.classList.remove('card-unmatched')
        const domainId = card.dataset.domainId
        const group = domainGroups.find((g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId)
        if (group) updateCardStats(card, group, false, '')
        refreshCardAfterFilter(card, false)
        visibleCardCount++
      }
      return
    }

    // Filtering is active — partition chips, decide if this card has
    // anything to show in this mode, and toggle visibility accordingly.
    let matchedCount = 0
    let unmatchedCount = 0
    chips.forEach((chip) => {
      const match = chipMatches(chip, q)
      if (match) matchedCount++
      else unmatchedCount++
      const shouldShow = mode === 'matched' ? match : !match
      chip.style.display = shouldShow ? '' : 'none'
    })

    const relevantCount = mode === 'matched' ? matchedCount : unmatchedCount
    if (relevantCount === 0) {
      card.style.display = 'none'
      return
    }
    card.style.display = ''
    visibleCardCount++

    if (mode === 'matched') {
      card.classList.remove('card-unmatched')
      const domainId = card.dataset.domainId
      const group = domainGroups.find((g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId)
      if (group) updateCardStats(card, group, true, q)
    } else {
      // Secondary grid: dim the card and hide bulk-close buttons so
      // they can't accidentally close matching tabs too.
      card.classList.add('card-unmatched')
      styleSecondaryCard(card)
    }

    // Hide empty sub-sections, update header counts, and sync the
    // card's tab-count badge to the visible chip count. Handled in a
    // single helper because the same logic applies to matched and
    // unmatched grids — both want "show what's visible, hide what's
    // not" at the section level.
    refreshCardAfterFilter(card, true)
  })

  return visibleCardCount
}

export function applyTabFilter(query) {
  const q = (query || '').trim().toLowerCase()
  const filtering = q.length > 0

  filterGrid('openTabsMissions', q, filtering, 'matched')
  const secondaryVisible = filterGrid('openTabsMissionsUnmatched', q, filtering, 'unmatched')

  const secondaryWrap = document.getElementById('openTabsMissionsOther')
  if (secondaryWrap) {
    secondaryWrap.style.display = filtering && secondaryVisible > 0 ? '' : 'none'
  }

  packMissionsMasonry({ unpin: true })
  renderHeaderStats()
}

let filterTimer = null

/* ---- Listeners — set up once at module load ---- */

/** Sync the wrapper's `.has-value` class to the input's current value so
 *  the ✕ clear button CSS can toggle visibility without JS on each
 *  frame. Called from the input listener + after the ✕ click. */
function syncFilterWrapClass(input) {
  const wrap = input && input.closest ? input.closest('.tab-filter-wrap') : null
  if (wrap) wrap.classList.toggle('has-value', input.value.length > 0)
}

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
  syncFilterWrapClass(input)
  applyTabFilter(input.value)
})
