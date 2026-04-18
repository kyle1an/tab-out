/* ================================================================
   Live tab filter

   • applyTabFilter(query) — hides chips/cards that don't match
   • Debounced input listener on #tabFilter
   • Esc to clear
   • Type-to-filter: typing anywhere on the page focuses the input
     and pipes the keystroke through (Slack/Linear/GitHub style)
   ================================================================ */

import { packMissionsMasonry } from './layout.js';
import { domainGroups, updateTabCountDisplays, updateSectionCount, updateFilteredActions, ICONS } from './render.js';
import { isGroupedTab } from './groups.js';

// When the page has focus, the type-to-filter listener below captures
// keystrokes from anywhere on the page. Surface that affordance in the
// placeholder so the hint matches reality.
const PLACEHOLDER_DEFAULT = 'Filter tabs…';
const PLACEHOLDER_FOCUSED = 'Type anywhere to filter…';

function updateFilterPlaceholder() {
  const input = document.getElementById('tabFilter');
  if (!input) return;
  const pageFocused = document.hasFocus();
  input.placeholder = pageFocused ? PLACEHOLDER_FOCUSED : PLACEHOLDER_DEFAULT;
  // `.capture-ready` gives the input a subtler pre-focus look so the user
  // trusts keystrokes will land here even before clicking in.
  input.classList.toggle('capture-ready', pageFocused);
}

/**
 * applyTabFilter(query) — hide non-matching chips and any card left empty.
 * While filtering, the "+N more" overflow container is force-opened so a
 * matching hidden chip isn't left invisible. Empty query restores the
 * default view.
 */
/**
 * Per-card counts + button labels that reflect the active filter. Shared
 * with no filter case (matchingTabs === group.tabs), so the same pass
 * also restores original labels when the filter is cleared.
 */
function updateCardStats(card, group, filtering, q) {
  const matchingTabs = filtering
    ? group.tabs.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.url   || '').toLowerCase().includes(q))
    : group.tabs;
  const closableTabs = matchingTabs.filter(t => !isGroupedTab(t));

  // Tab count badge (skip app-badge — has its own format)
  const tabBadge = card.querySelector('.tab-count-badge:not(.app-badge)');
  if (tabBadge) {
    tabBadge.innerHTML = `${ICONS.tabs} ${matchingTabs.length}`;
    tabBadge.title = `${matchingTabs.length} open tab${matchingTabs.length !== 1 ? 's' : ''}`;
  }

  // Close-domain button (top-right corner of card)
  const closeBtn = card.querySelector('.card-close-btn');
  if (closeBtn) {
    if (closableTabs.length === 0) {
      closeBtn.style.display = 'none';
    } else {
      closeBtn.style.display = '';
      const label = closableTabs.length === matchingTabs.length
        ? `Close all ${closableTabs.length} tab${closableTabs.length !== 1 ? 's' : ''}`
        : `Close ${closableTabs.length} ungrouped tab${closableTabs.length !== 1 ? 's' : ''}`;
      const textSpan = closeBtn.querySelector('.card-close-btn-text');
      if (textSpan) textSpan.textContent = label;
    }
  }

  // Dedup button — recompute the 4-case policy on matching tabs only
  const dupeInfo = {};
  const urlCounts = {};
  for (const tab of matchingTabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
    if (!dupeInfo[tab.url]) dupeInfo[tab.url] = { total: 0, ungrouped: 0, groupIds: new Set() };
    const info = dupeInfo[tab.url];
    info.total++;
    if (isGroupedTab(tab)) info.groupIds.add(tab.groupId);
    else info.ungrouped++;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const closableForUrl = (u) => {
    const info = dupeInfo[u];
    if (!info) return 0;
    const grouped = info.total - info.ungrouped;
    if (grouped >= 1 && info.ungrouped >= 1) return info.ungrouped;
    if (grouped === 0 && info.ungrouped >= 2) return info.ungrouped - 1;
    if (grouped >= 2 && info.groupIds.size === 1) return info.total - 1;
    return 0;
  };
  const closableDupeUrls = dupeUrls.map(([u]) => u).filter(u => closableForUrl(u) > 0);
  const closableExtras = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0);

  const dedupBtn = card.querySelector('[data-action="dedup-keep-one"]');
  if (dedupBtn) {
    if (closableExtras === 0) {
      dedupBtn.style.display = 'none';
    } else {
      dedupBtn.style.display = '';
      dedupBtn.textContent = `Close ${closableExtras} duplicate${closableExtras !== 1 ? 's' : ''}`;
      dedupBtn.dataset.dupeUrls = closableDupeUrls.map(encodeURIComponent).join(',');
    }
  }
}

export function applyTabFilter(query) {
  const q = (query || '').trim().toLowerCase();
  const filtering = q.length > 0;
  const container = document.getElementById('openTabsMissions');
  if (!container) return;

  container.querySelectorAll('.mission-card').forEach(card => {
    const chips     = card.querySelectorAll('.page-chip[data-action="focus-tab"]');
    const overflow  = card.querySelector('.page-chips-overflow');
    const moreBtn   = card.querySelector('.page-chip-overflow');

    let anyMatch = false;
    chips.forEach(chip => {
      if (!filtering) { chip.style.display = ''; anyMatch = true; return; }
      const text = chip.textContent.toLowerCase();
      const url  = (chip.dataset.tabUrl || '').toLowerCase();
      const hit  = text.includes(q) || url.includes(q);
      chip.style.display = hit ? '' : 'none';
      if (hit) anyMatch = true;
    });

    if (overflow) {
      if (filtering) {
        if (overflow.dataset.preFilter === undefined) {
          overflow.dataset.preFilter = overflow.style.display || '';
        }
        overflow.style.display = 'contents';
      } else if (overflow.dataset.preFilter !== undefined) {
        overflow.style.display = overflow.dataset.preFilter;
        delete overflow.dataset.preFilter;
      }
    }
    if (moreBtn) moreBtn.style.display = filtering ? 'none' : '';

    card.style.display = anyMatch ? '' : 'none';

    // Keep the card's counts + action buttons in sync with the filter
    const domainId = card.dataset.domainId;
    const group = domainGroups.find(g =>
      'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId
    );
    if (group) updateCardStats(card, group, filtering, q);
  });

  packMissionsMasonry({ unpin: true });
  updateTabCountDisplays();
  updateSectionCount();
  updateFilteredActions();
}

let filterTimer = null;

/* ---- Listeners — set up once at module load ---- */

// Debounced input on the filter field
document.addEventListener('input', (e) => {
  if (e.target.id !== 'tabFilter') return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => applyTabFilter(e.target.value), 80);
});

// Esc clears the filter while it's focused — quick escape hatch.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const input = document.getElementById('tabFilter');
  if (!input || document.activeElement !== input) return;
  if (input.value !== '') {
    input.value = '';
    applyTabFilter('');
  } else {
    input.blur();
  }
});

// Keep the placeholder in sync with window focus state — hint only
// shows "Just start typing…" while the page can actually capture keys.
window.addEventListener('focus', updateFilterPlaceholder);
window.addEventListener('blur',  updateFilterPlaceholder);
updateFilterPlaceholder();

// Type-to-filter: when the user starts typing anywhere (no modifier,
// not already in an input), auto-focus the filter and pipe the
// keystroke in. Mirrors Slack / Linear / GitHub.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT' ||
    a.tagName === 'TEXTAREA' ||
    a.tagName === 'SELECT' ||
    a.isContentEditable
  )) return;
  const input = document.getElementById('tabFilter');
  if (!input) return;
  e.preventDefault();
  input.focus();
  input.value += e.key;
  applyTabFilter(input.value);
});
