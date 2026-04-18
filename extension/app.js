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
import { closeTabsByUrls, closeTabsExact, closeDuplicateTabs,
         closeTabOutDupes, focusTab, fetchOpenTabs, snapshotChromeTabs } from './tabs.js';
import { packMissionsMasonry }                                     from './layout.js';
import { shootConfetti }                                           from './confetti.js';
import { showToast, animateCardOut, updateCloseTabsButton }        from './ui.js';
import { markClosure }                                             from './undo.js';
import {
  renderStaticDashboard, getFilteredTabs, updateTabCountDisplays,
  domainGroups, ICONS,
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

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
      packMissionsMasonry();
    }
    return;
  }

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

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs.
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    const snapshot = useExact
      ? await closeTabsExact(urls, { preserveGroups: true })
      : await closeTabsByUrls(urls, { preserveGroups: true });

    if (card) animateCardOut(card);

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__'
      ? 'Homepages'
      : (group.label || group.domain.replace(/^www\./, ''));
    markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} from ${groupLabel}`);

    updateTabCountDisplays();
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    // Read the count from the button's own label before we fade it out.
    const extrasClosed = parseInt((actionEl.textContent.match(/\d+/) || ['0'])[0], 10);

    const dupeSnapshot = await closeDuplicateTabs(urls, true);

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      // Decrement the card's visible tab counts by the number of dupes closed
      const tabsBadge = card.querySelector('.tab-count-badge');
      if (tabsBadge) {
        const current = parseInt((tabsBadge.textContent.match(/\d+/) || ['0'])[0], 10);
        const next    = Math.max(0, current - extrasClosed);
        tabsBadge.innerHTML = `${ICONS.tabs} ${next}`;
        tabsBadge.title    = `${next} open tab${next !== 1 ? 's' : ''}`;
      }
      const meta = card.querySelector('.mission-page-count');
      if (meta) {
        const current = parseInt(meta.textContent, 10) || 0;
        meta.textContent = String(Math.max(0, current - extrasClosed));
      }
      updateCloseTabsButton(card.querySelector('[data-action="close-domain-tabs"]'), extrasClosed);
    }

    updateTabCountDisplays();
    updateCloseTabsButton(
      document.querySelector('#openTabsSectionCount [data-action="close-all-open-tabs"]'),
      extrasClosed
    );

    setTimeout(() => packMissionsMasonry(), 250);

    markClosure(dupeSnapshot, `Closed ${dupeSnapshot.length} duplicate${dupeSnapshot.length !== 1 ? 's' : ''}`);
    return;
  }

  // ---- Close ALL open tabs (or only filter-matching tabs when active) ----
  if (action === 'close-all-open-tabs') {
    // When filter is active, exact URL match prevents closing sibling tabs
    // from the same hostname that the user has filtered out.
    const candidates = getFilteredTabs()
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    const allSnapshot = await closeTabsExact(candidates, { preserveGroups: true });

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    updateTabCountDisplays();

    if (allSnapshot.length > 0) {
      markClosure(allSnapshot, `Closed ${allSnapshot.length} tab${allSnapshot.length !== 1 ? 's' : ''}`);
    } else {
      showToast('Nothing to close');
    }
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
