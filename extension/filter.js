/* ================================================================
   Live tab filter

   • applyTabFilter(query) — hides chips/cards that don't match
   • Debounced input listener on #tabFilter
   • Esc to clear
   • Type-to-filter: typing anywhere on the page focuses the input
     and pipes the keystroke through (Slack/Linear/GitHub style)
   ================================================================ */

import { packMissionsMasonry } from './layout.js';
import { updateTabCountDisplays, updateSectionCount } from './render.js';

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
  });

  packMissionsMasonry({ unpin: true });
  updateTabCountDisplays();
  updateSectionCount();
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
