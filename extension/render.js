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

export let domainGroups = [];

/* ---- SVG icon strings ---- */
export const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};

/**
 * pickFavicon(tab) — prefer the page's own favicon (chrome scrapes it
 * from the page's <link rel="icon">), fall back to Google's service.
 * The capture-phase error listener in app.js hides any that fail to load.
 */
export function pickFavicon(tab) {
  const fav = tab.favIconUrl || '';
  if (fav && !fav.startsWith('chrome://') && !fav.startsWith('chrome-extension://')) {
    return fav;
  }
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch {}
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '';
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
 * visible title, return the shortest trailing-stripped path for each
 * that still uniquely identifies it. Common trailing path segments
 * are stripped (they're identical across all URLs, so contribute no
 * distinguishing info); whatever remains is what the user needs to
 * see to tell the chips apart.
 *
 *   ["/admin/users/dashboard", "/user/dashboard"] → ["/admin/users", "/user"]
 *   ["/dashboard", "/admin/dashboard"]            → ["/", "/admin"]
 */
function disambiguatingPaths(urls) {
  const paths = urls.map(u => {
    try { return new URL(u).pathname.split('/').filter(Boolean); }
    catch { return []; }
  });
  let commonTrail = 0;
  const minLen = Math.min(...paths.map(p => p.length));
  for (let i = 1; i <= minLen; i++) {
    const seg = paths[0][paths[0].length - i];
    if (paths.every(p => p[p.length - i] === seg)) commonTrail = i;
    else break;
  }
  return paths.map(p => {
    const show = p.slice(0, p.length - commonTrail);
    return show.length ? '/' + show.join('/') : '/';
  });
}

/* ---- Overflow chips ("+N more") ----
   showPrefix: when a subdomain section has its own header, the chip
   prefix is redundant — suppress it in overflow chips too.
   pathByUrl: map of URL → disambiguating path suffix for colliding
   titles within this section; applies to overflow chips as well so
   expansion stays consistent with visible chips. */
function buildOverflowChips(hiddenTabs, urlCounts = {}, groupDomain = '', showPrefix = true, pathByUrl = null) {
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
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const safeUrl   = (tab.rawUrl || tab.url || '').replace(/"/g, '&quot;');
    const tooltip = [subPrefix, label, pathSuffix].filter(Boolean).join(' · ');
    const safeTitle = tooltip.replace(/"/g, '&quot;');
    let chipInner = subPrefix
      ? `<span class="chip-subdomain">${subPrefix}</span>${label}`
      : label;
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

/* ---- Domain card ---- */
function renderDomainCard(group) {
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
  // would otherwise render identical titles.
  function renderChip(tab, showPrefix, pathSuffix) {
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
    const tooltip = [leadPrefix, label, pathSuffix].filter(Boolean).join(' · ');
    const safeTitle = tooltip.replace(/"/g, '&quot;');
    let chipInner = leadPrefix
      ? `<span class="chip-subdomain">${leadPrefix}</span>${label}`
      : label;
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
    const visible = sectionTabs.slice(0, CHIPS_PER_SECTION);
    const hidden  = sectionTabs.slice(CHIPS_PER_SECTION);
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
    const header = showHeader
      ? `<div class="subdomain-header">
          <span class="subdomain-header-name">${key}</span>
          <span class="subdomain-header-count">${sectionTabs.length}</span>
        </div>`
      : '';
    const chips = visible.map(tab => renderChip(tab, showChipPrefix, pathByUrl.get(tab.url) || '')).join('');
    const overflow = hidden.length > 0
      ? buildOverflowChips(hidden, urlCounts, group.domain, showChipPrefix, pathByUrl)
      : '';
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
  const prevExpanded = new Map();  // domainId -> Set<subdomainKey>
  if (openTabsMissionsEl) {
    let idx = 0;
    for (const c of openTabsMissionsEl.querySelectorAll('.mission-card')) {
      const id = c.dataset.domainId;
      if (!id) continue;
      prevOrder.set(id, idx++);
      if (c.dataset.masonryCol !== undefined) {
        prevColumns.set(id, c.dataset.masonryCol);
      }
      const expandedKeys = new Set();
      c.querySelectorAll('.subdomain-section[data-expanded="true"]').forEach(s => {
        const k = s.dataset.subdomainKey;
        if (k) expandedKeys.add(k);
      });
      if (expandedKeys.size > 0) prevExpanded.set(id, expandedKeys);
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
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsMissionsEl.querySelectorAll('.mission-card').forEach(c => {
      const id = c.dataset.domainId;
      const savedCol = prevColumns.get(id);
      if (savedCol !== undefined) c.dataset.masonryCol = savedCol;
      // Re-apply the "expanded overflow" state per subdomain section so
      // closing a tab inside one expanded sub-group doesn't collapse it.
      const expandedKeys = prevExpanded.get(id);
      if (expandedKeys) {
        expandedKeys.forEach(key => {
          const section = c.querySelector(`.subdomain-section[data-subdomain-key="${key}"]`);
          if (!section) return;
          const overflow = section.querySelector('.page-chips-overflow');
          if (overflow) overflow.style.display = 'contents';
          const moreBtn = section.querySelector('.page-chip-overflow');
          if (moreBtn) moreBtn.remove();
          section.dataset.expanded = 'true';
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
