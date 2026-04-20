/* ================================================================
   Live tab filter

   • applyTabFilter(query) — hides chips/cards that don't match
   • Debounced input listener on #tabFilter
   • Esc to clear
   • Type-to-filter: typing anywhere on the page focuses the input
     and pipes the keystroke through (Slack/Linear/GitHub style)
   ================================================================ */

import { packMissionsMasonry } from './layout.js'
import { domainGroups, updateTabCountDisplays, updateSectionCount, updateFilteredActions } from './render.js'
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

/** Style a card in the secondary ("Other tabs") grid. Shows the count
 *  of non-matching tabs in the badge and hides every bulk-close button
 *  — close-domain, dedup, cluster-close, subdomain-close. All those
 *  buttons operate on the card's full tab set (not just the chips
 *  visible in this grid), so exposing them here would let a user who
 *  typed "github" accidentally bulk-close matching tabs too. Per-chip
 *  close (the `×` on each chip) stays active for targeted cleanup. */
function styleSecondaryCard(card, unmatchedTabCount) {
  const tabBadge = card.querySelector('.tab-count-badge:not(.app-badge)')
  if (tabBadge) {
    tabBadge.textContent = String(unmatchedTabCount)
    tabBadge.title = `${unmatchedTabCount} non-matching tab${unmatchedTabCount !== 1 ? 's' : ''}`
  }

  card.querySelectorAll('.card-close-btn, [data-action="dedup-keep-one"], .pathgroup-close-btn, .subdomain-close-btn').forEach((btn) => {
    btn.style.display = 'none'
  })
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
        chip.classList.remove('chip-unmatched')
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
      chip.classList.remove('chip-unmatched')
    })

    const relevantCount = mode === 'matched' ? matchedCount : unmatchedCount
    if (relevantCount === 0) {
      card.style.display = 'none'
      return
    }
    card.style.display = ''
    visibleCardCount++

    const domainId = card.dataset.domainId
    const group = domainGroups.find((g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId)

    if (mode === 'matched') {
      card.classList.remove('card-unmatched')
      if (group) updateCardStats(card, group, true, q)
    } else {
      // Secondary grid: dim the card as a whole and show the
      // unmatched-tab count in the badge. The unmatched count of
      // chip-level elements isn't the same as tab count (dedup
      // collapses duplicate URLs), so use the per-tab count derived
      // from group.tabs so the badge matches what a user would
      // expect "this many tabs aren't in my filter".
      card.classList.add('card-unmatched')
      if (group) {
        const unmatchedTabCount = group.tabs.filter((t) => {
          const title = (t.title || '').toLowerCase()
          const url = (t.url || '').toLowerCase()
          return !(title.includes(q) || url.includes(q))
        }).length
        styleSecondaryCard(card, unmatchedTabCount)
      }
    }
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
