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

import { closeTabsExact, closeDuplicateTabs, closeTabOutDupes } from './tabs.js'
import { showToast, mountToast } from './components/Toast.js'
import { markClosure } from './undo.js'
import { renderStaticDashboard, getFilteredCloseableUrls } from './render.js'
// filter.js is imported for its side effects only — attaching the
// input / keyboard / paste listeners at module load.
import './filter.js'
import { groupColorChanged } from './groups.js'

/* ----------------------------------------------------------------
   LIVE SYNC — re-render on chrome.tabs / chrome.tabGroups events

   Cheaper than polling and keeps the dashboard truthful when tabs
   change in another window. Every event is debounced into one full
   re-render that re-derives state from chrome.tabs.query — no risk
   of in-memory state diverging from reality. While the page is hidden
   we skip work; on visibilitychange back to visible, we refresh
   immediately so the user lands on a current view.
   ---------------------------------------------------------------- */

let refreshTimer = null

async function refreshDashboard() {
  if (document.visibilityState !== 'visible') return
  await renderStaticDashboard()
  // No need to reapply the filter — the VM reads filter.js's state
  // on every render, so filter-scoped visibility is reproduced
  // automatically on every rebuild.
}

function scheduleDashboardRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(refreshDashboard, 250)
}

if (chrome.tabs) {
  chrome.tabs.onCreated.addListener(scheduleDashboardRefresh)
  chrome.tabs.onRemoved.addListener(scheduleDashboardRefresh)
  chrome.tabs.onMoved.addListener(scheduleDashboardRefresh)
  chrome.tabs.onAttached.addListener(scheduleDashboardRefresh)
  chrome.tabs.onDetached.addListener(scheduleDashboardRefresh)
  // onUpdated fires for many properties (audible, mutedInfo, status, etc.).
  // Only refresh for changes that actually affect what we render.
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (
      changeInfo.title !== undefined ||
      changeInfo.url !== undefined ||
      changeInfo.favIconUrl !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined ||
      changeInfo.discarded !== undefined
    )
      scheduleDashboardRefresh()
  })
}

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(scheduleDashboardRefresh)
  // onUpdated fires for collapsed, color, and title — only color affects
  // what we render, so skip re-renders for the other two.
  chrome.tabGroups.onUpdated.addListener((group) => {
    if (groupColorChanged(group)) scheduleDashboardRefresh()
  })
  chrome.tabGroups.onRemoved.addListener(scheduleDashboardRefresh)
  chrome.tabGroups.onMoved.addListener(scheduleDashboardRefresh)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    closeTabOutDupes()
    refreshDashboard()
  }
})

/* ----------------------------------------------------------------
   CAPTURE-PHASE IMAGE ERROR LISTENER

   Hides any <img> that fails to load (favicons from google.com/s2/favicons
   occasionally 404 or get blocked). Inline `onerror=...` attributes would
   trip Manifest V3's CSP, so we use a capture-phase listener — error
   events don't bubble, but they do capture.
   ---------------------------------------------------------------- */

document.addEventListener(
  'error',
  (e) => {
    const el = e.target
    if (el && el.tagName === 'IMG') el.style.display = 'none'
  },
  true
)

/* ----------------------------------------------------------------
   URL PREVIEW — Chrome-style bottom-left status bar

   Shows the target URL whenever the cursor hovers an element whose
   click would switch tabs: regular chip body (data-action="focus-tab")
   and folded-chip env pills (data-action="focus-env"). Uses mouseover
   / mouseout delegation with a `.closest()` selector so transitions
   between overlapping matching elements (pill inside chip) never
   flicker — when the cursor moves from pill to surrounding chip body,
   mouseover on the new target replaces the text in-place.

   Folded chips carry every env URL space-joined in data-tab-url (for
   filter matching); the preview shows just the first URL since that's
   what a click on the chip body actually focuses.
   ---------------------------------------------------------------- */
{
  const urlPreview = document.getElementById('urlPreview')
  const urlPreviewText = document.getElementById('urlPreviewText')
  const HOVER_SELECTOR = '[data-action="focus-tab"], [data-action="focus-env"]'
  let currentHoverTarget = null

  function hidePreview() {
    if (!urlPreview) return
    urlPreview.classList.remove('visible')
    currentHoverTarget = null
  }

  document.addEventListener('mouseover', (e) => {
    if (!urlPreview || !urlPreviewText) return
    const target = e.target.closest(HOVER_SELECTOR)
    if (!target || target === currentHoverTarget) return
    const raw = target.dataset.tabUrl || ''
    const displayUrl = raw.split(' ')[0]
    if (!displayUrl) return
    urlPreviewText.textContent = displayUrl
    urlPreview.classList.add('visible')
    currentHoverTarget = target
  })

  document.addEventListener('mouseout', (e) => {
    if (!currentHoverTarget) return
    const to = e.relatedTarget
    const nextTarget = to && to.closest ? to.closest(HOVER_SELECTOR) : null
    // Still inside the same matching element (cursor crossed into a
    // child like the favicon or close button) — keep the preview.
    if (nextTarget === currentHoverTarget) return
    // If moving to a DIFFERENT matching element, the paired mouseover
    // will switch the text; only hide when leaving the selector set.
    if (!nextTarget) hidePreview()
  })

  // Scroll / blur cleanup so a preview stranded by an unrelated DOM
  // change doesn't stay on-screen.
  window.addEventListener('blur', hidePreview)
  document.addEventListener('scroll', hidePreview, { passive: true, capture: true })
}

/* ----------------------------------------------------------------
   DOCUMENT-LEVEL CLICK DELEGATION

   One listener handles every action button on the page. Each
   data-action value branches to its handler.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]')
  if (!actionEl) return

  const action = actionEl.dataset.action

  // Component-local handlers (not in this switch):
  //   close-domain-tabs, dedup-keep-one → components/DomainCard.js
  //   expand-chips (for pathgroup-section) → components/PathgroupSection.js
  //   close-pathgroup-tabs → components/PathgroupSection.js
  //   expand-chips (for flat-section)     → components/FlatSection.js
  //   focus-tab, close-single-tab         → components/PageChip.js
  // `data-action="close-domain-tabs"` and `data-action="dedup-keep-one"`
  // still appear on their buttons as selector anchors for
  // filter.js / ui.js / dedup-global-keep-one below.

  // ---- Close every tab matching the current filter ----
  if (action === 'close-filtered-tabs') {
    const urls = getFilteredCloseableUrls()
    if (urls.length === 0) {
      showToast('Nothing to close')
      return
    }
    const snapshot = await closeTabsExact(urls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    } else {
      showToast('Nothing to close')
    }
    return
  }

  // ---- Close duplicates across EVERY card ----
  if (action === 'dedup-global-keep-one') {
    const perCardBtns = document.querySelectorAll('#openTabsMissions [data-action="dedup-keep-one"]')
    const allUrls = []
    perCardBtns.forEach((btn) => {
      ;(btn.dataset.dupeUrls || '')
        .split(',')
        .map((u) => decodeURIComponent(u))
        .filter(Boolean)
        .forEach((u) => allUrls.push(u))
    })
    if (allUrls.length === 0) return

    // Fade the global button + every per-card dedup button via the
    // shared `.closing` CSS class, then wait out the transition and
    // explicitly re-render — Preact drops the now-absent buttons +
    // (Nx) badges from the VM, counts refresh atomically.
    ;[actionEl, ...perCardBtns].forEach((b) => b.classList.add('closing'))

    const snapshot = await closeDuplicateTabs(allUrls, true)
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`)
    await new Promise((r) => setTimeout(r, 200))
    await renderStaticDashboard()
    return
  }
})

/* ----------------------------------------------------------------
   INITIALIZE

   Auto-close extra Tab Out tabs on load — only when this tab is
   foregrounded, so background Tab Out tabs don't close each other
   in a race. Each tab cleans up when the user actually focuses it.
   ---------------------------------------------------------------- */
mountToast()
if (document.visibilityState === 'visible') closeTabOutDupes()
renderStaticDashboard()

/* ----------------------------------------------------------------
   Contextual shadow under the pinned-top bar — only appears when
   the scroll region has scrolled away from the top.
   ---------------------------------------------------------------- */
{
  const scrollRegion = document.querySelector('.scroll-region')
  const pinnedTop = document.querySelector('.pinned-top')
  if (scrollRegion && pinnedTop) {
    scrollRegion.addEventListener(
      'scroll',
      () => {
        pinnedTop.classList.toggle('is-scrolled', scrollRegion.scrollTop > 0)
      },
      { passive: true }
    )
  }
}
