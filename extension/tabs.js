/* ================================================================
   Chrome tabs — fetch / close / focus / snapshot

   `openTabs` is the canonical in-memory cache of all open tabs.
   It's exported as a `let` binding so importers see updates after
   each fetchOpenTabs() call (ES module live bindings). Use
   getRealTabs() to get a filtered subset (skips chrome://, about:,
   extension pages).
   ================================================================ */

import { unwrapSuspenderUrl } from './suspender.js';
import { isGroupedTab, fetchTabGroupColors, scoreForKeep } from './groups.js';

export let openTabs = [];

/**
 * snapshotChromeTabs(chromeTabs) — captures enough info per tab to
 * recreate it later via chrome.tabs.create() (used by undo). Skips
 * chrome:// and chrome-extension:// URLs since those aren't worth
 * recreating.
 */
export function snapshotChromeTabs(chromeTabs) {
  return chromeTabs.map(t => ({
    url:      unwrapSuspenderUrl(t.url || ''),
    title:    t.title || '',
    pinned:   !!t.pinned,
    groupId:  typeof t.groupId === 'number' ? t.groupId : -1,
    windowId: t.windowId,
    index:    typeof t.index === 'number' ? t.index : undefined,
  })).filter(s => s.url && !s.url.startsWith('chrome://') && !s.url.startsWith('chrome-extension://'));
}

/**
 * fetchOpenTabs() — refreshes `openTabs` from chrome.tabs.query(),
 * normalizing each tab into our internal shape. Suspended tabs get
 * `url` = unwrapped real URL, `rawUrl` = Chrome's actual URL.
 */
export async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    // Fetch tabs and tab-group colors in parallel — both are cheap
    // network-free API calls.
    const [tabs] = await Promise.all([
      chrome.tabs.query({}),
      fetchTabGroupColors(),
    ]);
    openTabs = tabs.map(t => {
      const rawUrl = t.url || '';
      const effectiveUrl = unwrapSuspenderUrl(rawUrl);
      return {
        id:         t.id,
        url:        effectiveUrl,
        rawUrl:     rawUrl,
        suspended:  rawUrl !== effectiveUrl,
        title:      t.title,
        favIconUrl: t.favIconUrl || '',
        windowId:   t.windowId,
        active:     t.active,
        pinned:     t.pinned,
        groupId:    typeof t.groupId === 'number' ? t.groupId : -1,
        isTabOut:   rawUrl === newtabUrl || rawUrl === 'chrome://newtab/',
      };
    });
  } catch {
    openTabs = [];
  }
}

/**
 * getRealTabs() — `openTabs` minus chrome://, extension pages, about:,
 * etc. The grid only ever shows real web pages.
 */
export function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * closeTabsByUrls(urls, opts) — closes tabs whose hostname matches any
 * of the given URLs. file:// URLs are matched exactly (no hostname).
 * Returns a snapshot of what was closed for undo.
 */
export async function closeTabsByUrls(urls, opts = {}) {
  if (!urls || urls.length === 0) return [];
  const { preserveGroups = false } = opts;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toCloseTabs = allTabs.filter(tab => {
    if (preserveGroups && isGroupedTab(tab)) return false;
    const tabUrl = unwrapSuspenderUrl(tab.url || '');
    if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
    try {
      const tabHostname = new URL(tabUrl).hostname;
      return tabHostname && targetHostnames.includes(tabHostname);
    } catch { return false; }
  });

  const snapshot = snapshotChromeTabs(toCloseTabs);
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map(t => t.id));
  await fetchOpenTabs();
  return snapshot;
}

/**
 * closeTabsExact(urls, opts) — closes tabs by exact URL match.
 * Used for landing pages and filter-narrowed bulk close so we don't
 * accidentally close unrelated tabs from the same hostname.
 */
export async function closeTabsExact(urls, opts = {}) {
  if (!urls || urls.length === 0) return [];
  const { preserveGroups = false } = opts;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toCloseTabs = allTabs
    .filter(t => !(preserveGroups && isGroupedTab(t)) && urlSet.has(unwrapSuspenderUrl(t.url)));
  const snapshot = snapshotChromeTabs(toCloseTabs);
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map(t => t.id));
  await fetchOpenTabs();
  return snapshot;
}

/**
 * focusTab(url) — switch Chrome to the tab matching `url` (exact first,
 * hostname fallback) and focus its window.
 */
export async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  const targetEffective = unwrapSuspenderUrl(url);

  let matches = allTabs.filter(t => t.url === url || unwrapSuspenderUrl(t.url) === targetEffective);

  if (matches.length === 0) {
    try {
      const targetHost = new URL(targetEffective).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(unwrapSuspenderUrl(t.url)).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne) — closes duplicate tabs of each
 * URL according to the dedup policy (mirrors renderDomainCard's button
 * count math):
 *   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
 *   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
 *   • All grouped, single group → keep one, close the rest within that group.
 *   • All grouped, multi groups → skip (would empty a slot in each group).
 * Returns a snapshot of what was closed for undo.
 */
export async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  let currentWindowId = -1;
  try { currentWindowId = (await chrome.windows.getCurrent()).id; } catch {}
  const toCloseTabs = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => unwrapSuspenderUrl(t.url) === url);
    if (!keepOne) {
      for (const tab of matching) toCloseTabs.push(tab);
      continue;
    }

    const grouped   = matching.filter(t =>  isGroupedTab(t));
    const ungrouped = matching.filter(t => !isGroupedTab(t));
    const sortByScore = arr => arr.slice()
      .sort((a, b) => scoreForKeep(b, currentWindowId) - scoreForKeep(a, currentWindowId));

    if (grouped.length >= 1 && ungrouped.length >= 1) {
      for (const t of ungrouped) toCloseTabs.push(t);
    } else if (ungrouped.length >= 2) {
      const keep = sortByScore(ungrouped)[0];
      for (const t of ungrouped) {
        if (t.id !== keep.id) toCloseTabs.push(t);
      }
    } else if (grouped.length >= 2) {
      const distinctGroups = new Set(grouped.map(t => t.groupId));
      if (distinctGroups.size === 1) {
        const keep = sortByScore(grouped)[0];
        for (const t of grouped) {
          if (t.id !== keep.id) toCloseTabs.push(t);
        }
      }
    }
  }

  const snapshot = snapshotChromeTabs(toCloseTabs);
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map(t => t.id));
  await fetchOpenTabs();
  return snapshot;
}

/**
 * closeTabOutDupes() — closes extra Tab Out new-tab pages, keeping
 * the active one in the current window.
 */
export async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}
