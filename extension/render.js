/* ================================================================
   Render — DOM building for the dashboard

   • renderStaticDashboard — top-level render, owns `domainGroups`
   • renderDomainCard / buildOverflowChips — per-card HTML
   • updateTabCountDisplays — header line + windows sub-line
   • updateSectionCount — "X domains · Close N duplicates" header
   • pickFavicon — tab.favIconUrl > Google fallback
   ================================================================ */

import { openTabs, fetchOpenTabs, getRealTabs } from './tabs.js';
import { isGroupedTab, groupDotColor } from './groups.js';
import { unwrapSuspenderUrl } from './suspender.js';
import { cleanTitle, smartTitle, stripTitleNoise } from './titles.js';
import { packMissionsMasonry } from './layout.js';
import { registrableDomain, subdomainPrefix } from './domains.js';
import { resolvePathGroup } from './path-groups.js';
import { render as preactRender, h } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { Missions } from './components/Missions.js';

const html = htm.bind(h);

export let domainGroups = [];

/* ---- SVG icon strings ---- */
export const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};

/**
 * pickFavicon(tab) — two-path favicon resolver:
 *   • If tab.favIconUrl is a `data:` URI, use it as-is. That covers
 *     both pages that inline their favicons (fast already) AND other
 *     extensions that rewrite the favicon (e.g. The Marvellous
 *     Suspender dims it for suspended tabs — a signal we want to
 *     preserve). Going through _favicon/ here would silently drop
 *     the modification.
 *   • Otherwise fall through to Chrome's internal favicon cache
 *     (`_favicon/` scheme, Chrome 104+). Same cache the tab strip
 *     uses; eliminates network fetches for plain https: favicons.
 *
 * The capture-phase error listener in app.js hides any that still
 * fail to load. Requires the "favicon" permission in manifest.json.
 */
export function pickFavicon(tab) {
  const fav = tab.favIconUrl || '';
  if (fav.startsWith('data:')) return fav;
  if (!tab.url) return '';
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', tab.url);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.toString();
}

/**
 * escapeChipText(s) — minimal HTML-escape for text interpolated into
 * chip innerHTML. Used for path-group labels, which come from URL
 * segments (via path-groups.js adapters) and can in principle contain
 * `<`, `>`, or `&`. Tab titles aren't escaped elsewhere because they
 * come from Chrome already-sanitized, but adapter output is derived
 * from raw URLs so belt-and-suspenders is cheap.
 */
function escapeChipText(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

/**
 * stripPgPrefix(label, pgLabel) — remove a leading pill-label prefix
 * (plus a common separator) from the chip's title, so the pill and
 * the title don't both carry the same string.
 *
 *   pill "Zennioptical/zenni-b2c-frontend"
 *   title "Zennioptical/zenni-b2c-frontend PR #4706"
 *   → displayed title: "PR #4706"
 *
 * The title is left alone when it doesn't begin with the pill text
 * (e.g. Jira's "[CAB-1602] …" — pill is "CAB", title starts with
 * "["). And when the title is exactly the pill text (e.g. a repo
 * homepage), we keep the full title too — stripping would leave an
 * empty chip, which reads as a bug more than a feature.
 */
function stripPgPrefix(label, pgLabel) {
  if (!pgLabel || !label || label === pgLabel) return label;
  const seps = [' — ', ' – ', ' - ', ' · ', ': ', ' '];
  for (const sep of seps) {
    const p = pgLabel + sep;
    if (label.startsWith(p)) {
      const rest = label.slice(p.length).trim();
      return rest || label;
    }
  }
  return label;
}

/**
 * updateTabCountDisplays() — header line + window-count sub-line.
 * Reads the filter input directly so every call site respects the
 * active filter without having to know about it.
 *
 *   No filter:  "182 Open tabs"     /  "Across 3 windows"
 *   Filtering:  "14 of 182 Open tabs" / "Across 2 of 3 windows"
 */
export function updateTabCountDisplays() {
  const headerEl = document.getElementById('greeting');
  const subEl    = document.getElementById('dateDisplay');
  if (!headerEl) return;

  const realTabs = getRealTabs();
  const total    = realTabs.length;

  const filterInput = document.getElementById('tabFilter');
  const q = (filterInput && filterInput.value || '').trim().toLowerCase();

  const visibleTabs = q.length === 0
    ? realTabs
    : realTabs.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.url   || '').toLowerCase().includes(q)
      );
  const totalWindows   = new Set(realTabs.map(t => t.windowId)).size;
  const visibleWindows = new Set(visibleTabs.map(t => t.windowId)).size;

  if (q.length === 0) {
    headerEl.textContent = `${total} Open tab${total !== 1 ? 's' : ''}`;
  } else {
    headerEl.textContent = `${visibleTabs.length} of ${total} Open tab${total !== 1 ? 's' : ''}`;
  }

  if (subEl) {
    subEl.textContent = visibleWindows === totalWindows
      ? `Across ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`
      : `Across ${visibleWindows} of ${totalWindows} window${totalWindows !== 1 ? 's' : ''}`;
  }
}

/**
 * getFilteredCloseableUrls() — URLs of tabs the "Close N filtered tabs"
 * action would close: filter-matching, ungrouped, non-chrome. Returns []
 * when no filter is active. Shared between the button label + the action
 * handler so both see the same list.
 */
export function getFilteredCloseableUrls() {
  const filterInput = document.getElementById('tabFilter');
  const q = (filterInput && filterInput.value || '').trim().toLowerCase();
  if (!q) return [];
  return getRealTabs()
    .filter(t => !isGroupedTab(t))
    .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter(t => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))
    .map(t => t.url);
}

/**
 * updateFilteredActions() — left-side slot in `.section-header`. Empty
 * unless the filter is active and at least one closable tab matches.
 */
export function updateFilteredActions() {
  const el = document.getElementById('openTabsSectionActions');
  if (!el) return;
  const urls = getFilteredCloseableUrls();
  if (urls.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<button class="action-btn close-tabs" data-action="close-filtered-tabs" style="font-size:11px;padding:4px 12px;">${ICONS.close} Close ${urls.length} filtered tab${urls.length !== 1 ? 's' : ''}</button>`;
}

/**
 * updateSectionCount() — "X domains · Close N tabs" section header.
 * Domain count uses DOM-visible cards (so filter-hidden cards don't count).
 * Close button reflects ungrouped, filter-matching tabs only.
 */
export function updateSectionCount() {
  const sectionCount = document.getElementById('openTabsSectionCount');
  if (!sectionCount) return;

  const allCards = document.querySelectorAll('#openTabsMissions .mission-card');
  const totalDomains = allCards.length;
  if (totalDomains === 0) { sectionCount.innerHTML = ''; return; }

  const visibleDomains = Array.from(allCards)
    .filter(c => getComputedStyle(c).display !== 'none').length;

  const domainText = visibleDomains === totalDomains
    ? `${totalDomains} domain${totalDomains !== 1 ? 's' : ''}`
    : `${visibleDomains} of ${totalDomains} domain${totalDomains !== 1 ? 's' : ''}`;

  // Global dedup button — sum of closable extras across every per-card
  // dedup button currently rendered. Keeps the 4-case policy intact
  // (per-card buttons already encode only the closable URLs), so the
  // global total equals the sum of what each card would close.
  let dedupBtn = '';
  const perCardDedupBtns = document.querySelectorAll('#openTabsMissions .action-btn[data-action="dedup-keep-one"]');
  let globalExtras = 0;
  perCardDedupBtns.forEach(btn => {
    const m = btn.textContent.match(/\d+/);
    if (m) globalExtras += parseInt(m[0], 10);
  });
  if (globalExtras > 0) {
    dedupBtn = `<button class="action-btn" data-action="dedup-global-keep-one" style="font-size:11px;padding:4px 12px;">Close ${globalExtras} duplicate${globalExtras !== 1 ? 's' : ''}</button><span class="section-count-sep">·</span>`;
  }

  sectionCount.innerHTML = dedupBtn + domainText;
}

/**
 * disambiguatingPaths(urls) — given a list of URLs that share a
 * visible title, return just the *differing* tokens for each. Path
 * segments, query string, and hash are all treated as tokens in a
 * single list, so differences in any of them can disambiguate. The
 * longest common leading AND trailing tokens are stripped; only
 * what differs is shown.
 *
 *   ["/api/v1/accounts/team/dashboard",
 *    "/api/v1/accounts/me/dashboard"]      → ["…/team", "…/me"]
 *   ["/admin/dashboard", "/user/dashboard"] → ["/admin", "/user"]
 *   ["/dashboard", "/admin/dashboard"]      → ["/", "/admin"]
 *   ["/rewards?state=open",
 *    "/rewards?state=closed"]               → ["…?state=open", "…?state=closed"]
 *   ["/doc#intro", "/doc#conclusion"]       → ["…#intro", "…#conclusion"]
 */
function disambiguatingPaths(urls) {
  const tokens = urls.map(u => {
    try {
      const parsed = new URL(u);
      const t = parsed.pathname.split('/').filter(Boolean);
      if (parsed.search) t.push(parsed.search);   // "?foo=bar"
      if (parsed.hash)   t.push(parsed.hash);     // "#section"
      return t;
    } catch { return []; }
  });
  const minLen = Math.min(...tokens.map(t => t.length));

  let commonLead = 0;
  for (let i = 0; i < minLen; i++) {
    const seg = tokens[0][i];
    if (tokens.every(t => t[i] === seg)) commonLead = i + 1;
    else break;
  }

  let commonTrail = 0;
  const maxTrail = minLen - commonLead;
  for (let i = 1; i <= maxTrail; i++) {
    const seg = tokens[0][tokens[0].length - i];
    if (tokens.every(t => t[t.length - i] === seg)) commonTrail = i;
    else break;
  }

  return tokens.map(t => {
    const show = t.slice(commonLead, t.length - commonTrail);
    if (show.length === 0) return '/';
    // Path segments join with '/'; query/hash attach without a slash
    // (their leading sigil '?' or '#' is already a delimiter).
    let joined = '';
    for (const seg of show) {
      if (seg.startsWith('?') || seg.startsWith('#')) joined += seg;
      else joined += (joined ? '/' : '') + seg;
    }
    const firstIsPath = !show[0].startsWith('?') && !show[0].startsWith('#');
    const lead = commonLead > 0 ? '…' : '';
    return lead + (firstIsPath ? '/' : '') + joined;
  });
}

/* ---- Overflow chips ("+N more") ----
   showPrefix: when a subdomain section has its own header, the chip
   prefix is redundant — suppress it in overflow chips too.
   pathByUrl: map of URL → disambiguating path suffix for colliding
   titles within this section; applies to overflow chips as well so
   expansion stays consistent with visible chips.
   pgLabelByUrl: map of URL → path-group pill label (from resolvePathGroup),
   filtered by the ≥2-member threshold in the caller. */
function buildOverflowChips(hiddenTabs, urlCounts = {}, groupDomain = '', showPrefix = true, pathByUrl = null, pgLabelByUrl = null) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    let subPrefix = '';
    if (showPrefix) {
      try {
        const parsed = new URL(tab.url);
        if (groupDomain) subPrefix = subdomainPrefix(parsed.hostname, groupDomain);
      } catch {}
    }
    const pathSuffix = pathByUrl ? (pathByUrl.get(tab.url) || '') : '';
    const pgLabel    = pgLabelByUrl ? (pgLabelByUrl.get(tab.url) || '') : '';
    const displayLabel = stripPgPrefix(label, pgLabel);
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const safeUrl   = (tab.rawUrl || tab.url || '').replace(/"/g, '&quot;');
    const tooltip = [subPrefix, pgLabel, label, pathSuffix].filter(Boolean).join(' · ');
    const safeTitle = tooltip.replace(/"/g, '&quot;');
    let chipInner = '';
    if (subPrefix) chipInner += `<span class="chip-subdomain">${subPrefix}</span>`;
    if (pgLabel)   chipInner += `<span class="chip-pathgroup">${escapeChipText(pgLabel)}</span>`;
    chipInner += displayLabel;
    if (pathSuffix) chipInner += `<span class="chip-path">${pathSuffix}</span>`;
    const faviconUrl = pickFavicon(tab);
    const groupStyle = isGroupedTab(tab)
      ? ` style="--group-color:${groupDotColor(tab.groupId)}"`
      : '';
    return `<div class="page-chip clickable" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}"${groupStyle}>
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${chipInner}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}

/* ---- Domain card ----
   Exported so the Preact <DomainCardShell> in components/Missions.js
   can inject the existing template-string output via
   dangerouslySetInnerHTML during Phase 1 of the migration. Later
   phases will inline the rendering logic into real components. */
export function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
  // Card is rendered as "app-style" only when every tab in it is running
  // in a standalone window (PWA/Chrome app). Mixed = treat as regular card.
  const isAppCard = tabs.length > 0 && tabs.every(t => t.isApp);

  // Tabs in a Chrome group are preserved by bulk close / dedup actions.
  const closableTabs  = tabs.filter(t => !isGroupedTab(t));
  const closableCount = closableTabs.length;

  // Count duplicates per URL, tracking grouped/ungrouped + which groups they're in.
  const dupeInfo = {}; // { url: { total, ungrouped, groupIds: Set } }
  const urlCounts = {};
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
    if (!dupeInfo[tab.url]) dupeInfo[tab.url] = { total: 0, ungrouped: 0, groupIds: new Set() };
    const info = dupeInfo[tab.url];
    info.total++;
    if (isGroupedTab(tab)) info.groupIds.add(tab.groupId);
    else info.ungrouped++;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);

  // Dedup policy (mirrors closeDuplicateTabs):
  //   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
  //   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
  //   • All grouped, single group → keep one, close the rest within that group.
  //   • All grouped, multi groups → skip (would empty a slot in each group).
  function closableForUrl(u) {
    const info = dupeInfo[u];
    if (!info) return 0;
    const grouped = info.total - info.ungrouped;
    if (grouped >= 1 && info.ungrouped >= 1) return info.ungrouped;
    if (grouped === 0 && info.ungrouped >= 2) return info.ungrouped - 1;
    if (grouped >= 2 && info.groupIds.size === 1) return info.total - 1;
    return 0;
  }
  const closableDupeUrls = dupeUrls.map(([u]) => u).filter(u => closableForUrl(u) > 0);
  const closableExtras   = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0);

  // App cards merge the "App" label and the tab count into one pill.
  // Apps usually have one tab, so the count is only shown when >1.
  const tabBadge = isAppCard
    ? `<span class="app-badge tab-count-badge" title="Running as a standalone app${tabCount > 1 ? ` · ${tabCount} tabs` : ''}">App${tabCount > 1 ? ` · ${tabCount}` : ''}</span>`
    : `<span class="open-tabs-badge tab-count-badge" title="${tabCount} open tab${tabCount !== 1 ? 's' : ''}">${tabCount}</span>`;

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  // Sort by title. stripTitleNoise first so leading "(1,234)" counts
  // don't bucket every active inbox under '(' — the sort key should
  // match what the user actually reads on the chip. `numeric: true`
  // gives natural number ordering (Dashboard 2 before Dashboard 11).
  uniqueTabs.sort((a, b) => {
    const aTitle = stripTitleNoise(a.title || '').toLowerCase();
    const bTitle = stripTitleNoise(b.title || '').toLowerCase();
    return aTitle.localeCompare(bTitle, undefined, { numeric: true });
  });

  // Group tabs by subdomain/port within the card. Root tabs (no
  // subdomain or lone "www") sit under an empty-string key.
  const bySubdomain = new Map();
  for (const tab of uniqueTabs) {
    let key = '';
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) {
        key = parsed.port;
      } else {
        key = subdomainPrefix(parsed.hostname, group.domain);
      }
    } catch {}
    if (!bySubdomain.has(key)) bySubdomain.set(key, []);
    bySubdomain.get(key).push(tab);
  }

  // Sort policy: root tabs (empty key) first, then the rest
  // alphabetically by subdomain. Alphabetical is predictable — the
  // same subdomain always lands in the same spot across refreshes,
  // regardless of tab counts or Chrome tab-strip order.
  const sections = [...bySubdomain.entries()].sort((a, b) => {
    if (a[0] === b[0]) return 0;
    if (a[0] === '') return -1;
    if (b[0] === '') return 1;
    return a[0].localeCompare(b[0]);
  });
  const multipleSections = sections.length > 1;
  // Single-subdomain card: hoist the subdomain up to a pill next to
  // the card title so chips don't repeat the prefix on every row.
  // Only for non-empty keys — all-root cards don't need a pill.
  const singleSubdomainKey =
    sections.length === 1 && sections[0][0] !== '' ? sections[0][0] : '';

  // Local chip renderer — closes over group + urlCounts. Extracted so
  // per-section iteration below stays readable. `pathSuffix` is the
  // disambiguation crumb shown when two tabs in the same section
  // would otherwise render identical titles. `pathGroupLabel` is the
  // inline pill for path-level clusters (e.g. a GitHub repo, a Jira
  // project) — already filtered by the ≥2-member threshold upstream,
  // so any non-empty value is a confirmed cluster member.
  function renderChip(tab, showPrefix, pathSuffix, pathGroupLabel) {
    let parsed = null;
    try { parsed = new URL(tab.url); } catch {}
    const hostname = parsed ? parsed.hostname : group.domain;
    const label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), hostname);
    let subPrefix = '';
    let portPrefix = '';
    if (parsed && showPrefix) {
      if (parsed.hostname === 'localhost' && parsed.port) portPrefix = parsed.port;
      else subPrefix = subdomainPrefix(parsed.hostname, group.domain);
    }
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const safeUrl   = (tab.rawUrl || tab.url || '').replace(/"/g, '&quot;');
    const leadPrefix = subPrefix || portPrefix;
    const pgLabel    = pathGroupLabel || '';
    const displayLabel = stripPgPrefix(label, pgLabel);
    const tooltip = [leadPrefix, pgLabel, label, pathSuffix].filter(Boolean).join(' · ');
    const safeTitle = tooltip.replace(/"/g, '&quot;');
    let chipInner = '';
    if (leadPrefix) chipInner += `<span class="chip-subdomain">${leadPrefix}</span>`;
    if (pgLabel)    chipInner += `<span class="chip-pathgroup">${escapeChipText(pgLabel)}</span>`;
    chipInner += displayLabel;
    if (pathSuffix) chipInner += `<span class="chip-path">${pathSuffix}</span>`;
    const faviconUrl = pickFavicon(tab);
    const groupStyle = isGroupedTab(tab)
      ? ` style="--group-color:${groupDotColor(tab.groupId)}"`
      : '';
    return `<div class="page-chip clickable" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}"${groupStyle}>
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${chipInner}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }

  // Per-section visible limit. With multiple subdomain sections in one
  // card, a global 8 would flood the card; 5 per section keeps each
  // sub-group scannable while the card stays compact.
  const CHIPS_PER_SECTION = 5;

  const pageChips = sections.map(([key, sectionTabs]) => {
    // Header appears only when a card has 2+ subdomain sections AND
    // the section isn't the empty-key "root" (card title already says
    // the root). When shown, the header replaces the per-chip prefix —
    // repeating "dev2ca" on every chip under a "dev2ca" header is noise.
    const showHeader = multipleSections && key !== '';
    // Suppress chip prefix whenever the subdomain info is shown
    // elsewhere — either a section header (multi-subdomain card) or
    // the card-title pill (single-subdomain card).
    const showChipPrefix = !showHeader && !singleSubdomainKey;

    // Title-collision disambiguation: if two tabs in this section
    // render with the same visible title, append the smallest path
    // crumb that tells them apart. Noiseless for the common case
    // (no collision → empty string → renderChip skips the crumb span).
    const pathByUrl = new Map();
    const sameTitle = new Map();
    for (const t of sectionTabs) {
      const titleKey = stripTitleNoise(t.title || '').toLowerCase();
      if (!sameTitle.has(titleKey)) sameTitle.set(titleKey, []);
      sameTitle.get(titleKey).push(t);
    }
    for (const collided of sameTitle.values()) {
      if (collided.length < 2) continue;
      const suffixes = disambiguatingPaths(collided.map(t => t.url));
      collided.forEach((t, i) => pathByUrl.set(t.url, suffixes[i]));
    }

    // Path-group pills: resolve each tab's path group (github repo,
    // jira project, contentful env, etc.) and only keep labels whose
    // group has ≥2 members in this section. A lone group is silent
    // clutter — the signal is "these belong together," which takes
    // at least two chips to convey. Extra guardrail: drop labels that
    // equal the subdomain or the card domain (redundant information
    // already carried by the section header or card title).
    const pgByUrl = new Map();
    const pgKeyCount = new Map();
    for (const t of sectionTabs) {
      const pg = resolvePathGroup(t.url);
      if (!pg) continue;
      pgByUrl.set(t.url, pg);
      pgKeyCount.set(pg.key, (pgKeyCount.get(pg.key) || 0) + 1);
    }
    const pgLabelByUrl = new Map();
    for (const [url, pg] of pgByUrl) {
      if (pgKeyCount.get(pg.key) < 2) continue;
      if (pg.label === key || pg.label === group.domain) continue;
      pgLabelByUrl.set(url, pg.label);
    }

    // Build cluster blocks (≥2 members share a path-group label) and
    // a singleton block. Clusters render as labeled sub-sections; the
    // pill becomes the header and inner chips skip their per-chip
    // pill. Singletons follow flat with no header. Each block manages
    // its OWN visible/hidden split and its OWN "+N more" expander —
    // when a cluster overflows, expansion happens inside the cluster
    // so hidden members never leave their header's visual context.
    const clusterByLabel = new Map();
    const singletonTabs = [];
    for (const t of sectionTabs) {
      const lbl = pgLabelByUrl.get(t.url);
      if (!lbl) { singletonTabs.push(t); continue; }
      if (!clusterByLabel.has(lbl)) clusterByLabel.set(lbl, []);
      clusterByLabel.get(lbl).push(t);
    }
    const sortedClusters = [...clusterByLabel.entries()].sort(
      (a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })
    );

    const header = showHeader
      ? `<div class="subdomain-header">
          <span class="subdomain-header-name">${key}</span>
          <span class="subdomain-header-count">${sectionTabs.length}</span>
        </div>`
      : '';

    // Per-cluster rendering with own budget + overflow.
    const clusterHtml = sortedClusters.map(([lbl, tabs]) => {
      const vis = tabs.slice(0, CHIPS_PER_SECTION);
      const hid = tabs.slice(CHIPS_PER_SECTION);
      // Cluster-level close: mirrors the card-close policy. Grouped
      // tabs are preserved (preserveGroups: true); button is hidden
      // when every cluster member is in a Chrome tab group.
      const clusterClosable = tabs.filter(t => !isGroupedTab(t));
      const closeBtn = clusterClosable.length > 0
        ? `<button class="pathgroup-close-btn" data-action="close-pathgroup-tabs" data-pathgroup-urls="${clusterClosable.map(t => encodeURIComponent(t.url)).join(',')}" title="Close ${clusterClosable.length} tab${clusterClosable.length !== 1 ? 's' : ''}">${ICONS.close}</button>`
        : '';
      // A stretchy hairline between the count and the close button:
      // it doubles as the section separator, so the header reads as
      // a "labeled rule" (pill on the left, action on the right) and
      // the visual boundary between sub-sections lives in one element
      // instead of two (previous between-section border is removed).
      const blockHeader = `<div class="pathgroup-header">
        <span class="chip-pathgroup">${escapeChipText(lbl)}</span>
        <span class="pathgroup-header-count">${tabs.length}</span>
        <span class="pathgroup-header-rule"></span>
        ${closeBtn}
      </div>`;
      const visChips = vis.map(t =>
        renderChip(t, showChipPrefix, pathByUrl.get(t.url) || '', '')
      ).join('');
      // Overflow inside a cluster: no pills (header carries the label).
      const blockOverflow = hid.length > 0
        ? buildOverflowChips(hid, urlCounts, group.domain, showChipPrefix, pathByUrl, null)
        : '';
      const safeLabel = lbl.replace(/"/g, '&quot;');
      return `<div class="pathgroup-section" data-pathgroup-label="${safeLabel}">${blockHeader}${visChips}${blockOverflow}</div>`;
    }).join('');

    // Flat singletons: own budget + overflow. Wrapped in .flat-section
    // so CSS adjacency selectors can place a separator between the
    // last cluster and the flat block, and so the expand handler can
    // scope overflow-expansion to this block alone. Singletons never
    // carry a pill (threshold filter drops lone-member groups), so
    // pgLabelByUrl is passed as null.
    const flatVis = singletonTabs.slice(0, CHIPS_PER_SECTION);
    const flatHid = singletonTabs.slice(CHIPS_PER_SECTION);
    const flatChips = flatVis.map(t =>
      renderChip(t, showChipPrefix, pathByUrl.get(t.url) || '', '')
    ).join('');
    const flatOverflow = flatHid.length > 0
      ? buildOverflowChips(flatHid, urlCounts, group.domain, showChipPrefix, pathByUrl, null)
      : '';
    const flatHtml = singletonTabs.length > 0
      ? `<div class="flat-section">${flatChips}${flatOverflow}</div>`
      : '';

    // Flat singletons render FIRST inside a subdomain section, then
    // named clusters. Mirrors the root-subdomain-first pattern used
    // at the card level — ungrouped/"no-label" items come before
    // named groupings in both layers.
    const chips = flatHtml + clusterHtml;
    const overflow = '';
    // data-subdomain-key pairs with render.js's expanded-state restore
    // so a specific section stays open across live-sync rebuilds.
    const sectionKey = key || '__root__';
    return `<div class="subdomain-section" data-subdomain-key="${sectionKey}">${header}${chips}${overflow}</div>`;
  }).join('');

  // Close-domain button moves to the top-right corner of the card as an
  // icon-only button that expands to show its label on hover (iOS/macOS
  // notification-center style). Dedup button stays in the inline actions row.
  let closeCardBtn = '';
  if (closableCount > 0) {
    const closeLabel = closableCount === tabCount
      ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}`
      : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`;
    closeCardBtn = `<button class="card-close-btn" data-action="close-domain-tabs" data-domain-id="${stableId}">
      <span class="card-close-btn-text">${closeLabel}</span>
      ${ICONS.close}
    </button>`;
  }

  let actionsHtml = '';
  if (closableExtras > 0) {
    const dupeUrlsEncoded = closableDupeUrls.map(url => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${closableExtras} duplicate${closableExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card${isAppCard ? ' is-app' : ''}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      ${closeCardBtn}
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || group.domain.replace(/^www\./, ''))}</span>
          ${singleSubdomainKey ? `<span class="mission-subdomain">${singleSubdomainKey}</span>` : ''}
          ${tabBadge}
        </div>
        <div class="actions">${actionsHtml}</div>
        <div class="mission-pages">${pageChips}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

/* ---- Main render ---- */
export async function renderStaticDashboard() {
  await fetchOpenTabs();
  const realTabs = getRealTabs();
  updateTabCountDisplays();

  // Group tabs by domain. Landing pages (Gmail inbox, X home, etc.) get
  // their own special group so they can be closed together without
  // affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists).
    // config.local.js is a classic script; its globals are on window.
    ...(window.LOCAL_LANDING_PAGE_PATTERNS || []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = window.LOCAL_CUSTOM_GROUPS || [];

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true;
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      // Roll up subdomains so dev1.foo.com + dev2.foo.com share one
      // card. registrableDomain() is a no-op for IPs, localhost, and
      // user-space suffixes like user.github.io — see domains.js.
      const key = registrableDomain(hostname);
      if (!groupMap[key]) groupMap[key] = { domain: key, tabs: [] };
      groupMap[key].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing-page sites, then by tab count.
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');

  // Snapshot the existing DOM so we can preserve masonry column
  // pinning, vertical order within columns, and per-subdomain
  // expansion state across rebuilds. Without the order snapshot,
  // cards swap places whenever tab counts change.
  const prevColumns = new Map();
  const prevOrder = new Map();
  // domainId -> Array<{ subdomainKey, pathgroupLabel? }>
  //   entry with pathgroupLabel=undefined marks a flat/singleton-level
  //   expansion (the subdomain section itself). With pathgroupLabel set,
  //   it marks a cluster sub-section inside that subdomain.
  const prevExpanded = new Map();
  if (openTabsMissionsEl) {
    let idx = 0;
    for (const c of openTabsMissionsEl.querySelectorAll('.mission-card')) {
      const id = c.dataset.domainId;
      if (!id) continue;
      prevOrder.set(id, idx++);
      if (c.dataset.masonryCol !== undefined) {
        prevColumns.set(id, c.dataset.masonryCol);
      }
      const expandedList = [];
      c.querySelectorAll('.pathgroup-section[data-expanded="true"]').forEach(s => {
        const pg   = s.dataset.pathgroupLabel;
        const sub  = s.closest('.subdomain-section');
        const subK = sub && sub.dataset.subdomainKey;
        if (pg && subK) expandedList.push({ subdomainKey: subK, pathgroupLabel: pg });
      });
      c.querySelectorAll('.flat-section[data-expanded="true"]').forEach(s => {
        const sub  = s.closest('.subdomain-section');
        const subK = sub && sub.dataset.subdomainKey;
        if (subK) expandedList.push({ subdomainKey: subK, flat: true });
      });
      if (expandedList.length > 0) prevExpanded.set(id, expandedList);
    }
  }

  // Stable re-sort: previously-seen cards keep their prior order; new
  // cards stay where the landing/priority/tab-count sort put them (at
  // the end, since `return 0` preserves Array.prototype.sort stability).
  const stableDomainId = (g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
  domainGroups.sort((a, b) => {
    const aPrev = prevOrder.get(stableDomainId(a));
    const bPrev = prevOrder.get(stableDomainId(b));
    if (aPrev !== undefined && bPrev !== undefined) return aPrev - bPrev;
    if (aPrev !== undefined) return -1;
    if (bPrev !== undefined) return 1;
    return 0;
  });

  const sectionHeaderWrap = document.getElementById('sectionHeaderWrap');
  if (domainGroups.length > 0 && openTabsSection) {
    // Phase 1: Preact owns #openTabsMissions via <Missions>. Inside,
    // <DomainCardShell> still emits the existing template-string card
    // HTML via dangerouslySetInnerHTML, so the snapshot/restore loop
    // below continues to work — it queries the newly-rendered
    // .mission-card elements, which exist regardless of the Preact
    // wrapper (`display: contents` keeps the wrapper invisible to
    // layout + descendant selectors).
    preactRender(html/* html */`<${Missions} domains=${domainGroups} />`, openTabsMissionsEl);
    openTabsMissionsEl.querySelectorAll('.mission-card').forEach(c => {
      const id = c.dataset.domainId;
      const savedCol = prevColumns.get(id);
      if (savedCol !== undefined) c.dataset.masonryCol = savedCol;
      // Re-apply the "expanded overflow" state per sub-section (either
      // subdomain-level for flat singletons or pathgroup-level for a
      // specific cluster) so closing a tab inside one expanded
      // sub-group doesn't collapse the others. `:scope >` constrains
      // the overflow lookup to the section's OWN overflow, so a
      // subdomain-level restore doesn't accidentally expand a child
      // cluster's overflow.
      const expandedList = prevExpanded.get(id);
      if (expandedList) {
        expandedList.forEach(({ subdomainKey, pathgroupLabel, flat }) => {
          const sub = c.querySelector(
            `.subdomain-section[data-subdomain-key="${CSS.escape(subdomainKey)}"]`
          );
          if (!sub) return;
          let target;
          if (pathgroupLabel) {
            target = sub.querySelector(
              `.pathgroup-section[data-pathgroup-label="${CSS.escape(pathgroupLabel)}"]`
            );
          } else if (flat) {
            target = sub.querySelector(':scope > .flat-section');
          }
          if (!target) return;
          const overflow = target.querySelector(':scope > .page-chips-overflow');
          if (overflow) overflow.style.display = 'contents';
          const moreBtn = target.querySelector(':scope > .page-chip-overflow');
          if (moreBtn) moreBtn.remove();
          target.dataset.expanded = 'true';
        });
      }
    });
    openTabsSection.style.display = 'block';
    if (sectionHeaderWrap) sectionHeaderWrap.style.display = '';
    packMissionsMasonry();
    updateSectionCount();
  } else {
    if (openTabsSection)    openTabsSection.style.display = 'none';
    if (sectionHeaderWrap)  sectionHeaderWrap.style.display = 'none';
  }

  updateTabCountDisplays();
  updateFilteredActions();
}
