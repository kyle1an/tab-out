/* ================================================================
   Tab Out — entry point

   Wires together:
     • Initial render of the dashboard
     • Live sync (re-render on chrome.tabs / chrome.tabGroups events)
     • Document-level click delegation for every action button
     • Capture-phase image-error listener (hides broken favicons)

   All implementation lives in dedicated modules:
     suspender.js  groups.js  titles.js  tabs.js
     layout.js     confetti.js  ui.js   undo.js
     render.js     filter.js
   ================================================================ */

import { unwrapSuspenderUrl }                                      from './suspender.js';
import { closeTabsExact, closeDuplicateTabs,
         closeTabOutDupes, focusTab, fetchOpenTabs, snapshotChromeTabs } from './tabs.js';
import { packMissionsMasonry }                                     from './layout.js';
import { shootConfetti }                                           from './confetti.js';
import { showToast, animateCardOut }                               from './ui.js';
import { markClosure }                                             from './undo.js';
import {
  renderStaticDashboard, updateTabCountDisplays,
  getFilteredCloseableUrls, domainGroups, ICONS,
} from './render.js';
import { applyTabFilter } from './filter.js';
import { groupColorChanged } from './groups.js';


/* ----------------------------------------------------------------
   LIVE SYNC — re-render on chrome.tabs / chrome.tabGroups events

   Cheaper than polling and keeps the dashboard truthful when tabs
   change in another window. Every event is debounced into one full
   re-render that re-derives state from chrome.tabs.query — no risk
   of in-memory state diverging from reality. While the page is hidden
   we skip work; on visibilitychange back to visible, we refresh
   immediately so the user lands on a current view.
   ---------------------------------------------------------------- */

let refreshTimer = null;

async function refreshDashboard() {
  if (document.visibilityState !== 'visible') return;
  await renderStaticDashboard();
  // Re-rendering wipes filter visibility on the freshly built chips —
  // reapply the active filter so what was hidden stays hidden.
  const input = document.getElementById('tabFilter');
  if (input && input.value) applyTabFilter(input.value);
}

function scheduleDashboardRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshDashboard, 250);
}

if (chrome.tabs) {
  chrome.tabs.onCreated .addListener(scheduleDashboardRefresh);
  chrome.tabs.onRemoved .addListener(scheduleDashboardRefresh);
  chrome.tabs.onMoved   .addListener(scheduleDashboardRefresh);
  chrome.tabs.onAttached.addListener(scheduleDashboardRefresh);
  chrome.tabs.onDetached.addListener(scheduleDashboardRefresh);
  // onUpdated fires for many properties (audible, mutedInfo, status, etc.).
  // Only refresh for changes that actually affect what we render.
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (
      changeInfo.title       !== undefined ||
      changeInfo.url         !== undefined ||
      changeInfo.favIconUrl  !== undefined ||
      changeInfo.groupId     !== undefined ||
      changeInfo.pinned      !== undefined ||
      changeInfo.discarded   !== undefined
    ) scheduleDashboardRefresh();
  });
}

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(scheduleDashboardRefresh);
  // onUpdated fires for collapsed, color, and title — only color affects
  // what we render, so skip re-renders for the other two.
  chrome.tabGroups.onUpdated.addListener((group) => {
    if (groupColorChanged(group)) scheduleDashboardRefresh();
  });
  chrome.tabGroups.onRemoved.addListener(scheduleDashboardRefresh);
  chrome.tabGroups.onMoved  .addListener(scheduleDashboardRefresh);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    closeTabOutDupes();
    refreshDashboard();
  }
});


/* ----------------------------------------------------------------
   CAPTURE-PHASE IMAGE ERROR LISTENER

   Hides any <img> that fails to load (favicons from google.com/s2/favicons
   occasionally 404 or get blocked). Inline `onerror=...` attributes would
   trip Manifest V3's CSP, so we use a capture-phase listener — error
   events don't bubble, but they do capture.
   ---------------------------------------------------------------- */

document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG') el.style.display = 'none';
}, true);


/* ----------------------------------------------------------------
   DOCUMENT-LEVEL CLICK DELEGATION

   One listener handles every action button on the page. Each
   data-action value branches to its handler.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  const card = actionEl.closest('.mission-card');

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Match on both raw and effective URL so the chip works even if the
    // tab has been (un)suspended since the last render.
    const allTabs = await chrome.tabs.query({});
    const targetEffective = unwrapSuspenderUrl(tabUrl);
    const match   = allTabs.find(t => t.url === tabUrl)
                || allTabs.find(t => unwrapSuspenderUrl(t.url) === targetEffective);
    const snapshot = match ? snapshotChromeTabs([match]) : [];
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
        packMissionsMasonry();
      }, 200);
    }

    updateTabCountDisplays();

    if (snapshot.length > 0) markClosure(snapshot, 'Tab closed');
    else showToast('Tab closed');
    return;
  }

  // Component-local handlers (not in this switch):
  //   close-domain-tabs, dedup-keep-one → components/DomainCard.js
  //   expand-chips (for pathgroup-section) → components/PathgroupSection.js
  //   close-pathgroup-tabs → components/PathgroupSection.js
  //   expand-chips (for flat-section)     → components/FlatSection.js
  // `data-action="close-domain-tabs"` and `data-action="dedup-keep-one"`
  // still appear on their buttons as selector anchors for
  // filter.js / ui.js / dedup-global-keep-one below.

  // ---- Close every tab matching the current filter ----
  if (action === 'close-filtered-tabs') {
    const urls = getFilteredCloseableUrls();
    if (urls.length === 0) { showToast('Nothing to close'); return; }
    const snapshot = await closeTabsExact(urls, { preserveGroups: true });
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`);
    } else {
      showToast('Nothing to close');
    }
    return;
  }

  // ---- Close duplicates across EVERY card ----
  if (action === 'dedup-global-keep-one') {
    const perCardBtns = document.querySelectorAll('#openTabsMissions [data-action="dedup-keep-one"]');
    const allUrls = [];
    perCardBtns.forEach(btn => {
      (btn.dataset.dupeUrls || '')
        .split(',').map(u => decodeURIComponent(u)).filter(Boolean)
        .forEach(u => allUrls.push(u));
    });
    if (allUrls.length === 0) return;

    // Fade the global button and each per-card dedup button before the
    // live-sync refresh arrives and rebuilds them.
    [actionEl, ...perCardBtns].forEach(b => {
      b.style.transition = 'opacity 0.2s';
      b.style.opacity    = '0';
      setTimeout(() => b.remove(), 200);
    });

    const snapshot = await closeDuplicateTabs(allUrls, true);
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`);
    return;
  }

});


/* ----------------------------------------------------------------
   INITIALIZE

   Auto-close extra Tab Out tabs on load — only when this tab is
   foregrounded, so background Tab Out tabs don't close each other
   in a race. Each tab cleans up when the user actually focuses it.
   ---------------------------------------------------------------- */
if (document.visibilityState === 'visible') closeTabOutDupes();
renderStaticDashboard();

/* ----------------------------------------------------------------
   Contextual shadow under the pinned-top bar — only appears when
   the scroll region has scrolled away from the top.
   ---------------------------------------------------------------- */
{
  const scrollRegion = document.querySelector('.scroll-region');
  const pinnedTop    = document.querySelector('.pinned-top');
  if (scrollRegion && pinnedTop) {
    scrollRegion.addEventListener('scroll', () => {
      pinnedTop.classList.toggle('is-scrolled', scrollRegion.scrollTop > 0);
    }, { passive: true });
  }
}
