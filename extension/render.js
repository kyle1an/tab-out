/* ================================================================
   Render — data pipeline + Preact mount point for the dashboard.

   After the Preact + HTM migration (Phases 1-5), this module no
   longer emits HTML strings. It handles the data side — tab
   fetching, domain/subdomain/cluster grouping, sort rules — and
   hands the derived view-model off to <Missions> / <DomainCard>
   / <SubdomainSection> / <PathgroupSection> / <FlatSection> /
   <PageChip> for declarative rendering.

   Exports:
   • renderStaticDashboard — top-level entry, rebuilds domainGroups
                             and mounts the Preact tree
   • mountMissions — re-renders the card grids against the current
                     filter; called by both renderStaticDashboard
                     (after a fetch) and filter.js (after a query change)
   • computeDomainCardViewModel — per-card VM, takes { filter, mode }
                                  and returns match-scoped fields
                                  (consumed by <DomainCard>)
   • renderHeaderStats — (re)renders the pinned-top stats row via
                         <HeaderStats>
   • domainGroups — live array of current grouping
   • getFilteredCloseableUrls — URLs the "Close N filtered tabs" action
                                would close (shared with app.js handler)
   • pickFavicon — tab.favIconUrl (preserves data: URIs) /
                   chrome.runtime.getURL('/_favicon/?pageUrl=...')
   ================================================================ */

import { openTabs, fetchOpenTabs, getRealTabs } from './tabs.js'
import { isGroupedTab, groupDotColor } from './groups.js'
import { unwrapSuspenderUrl } from './suspender.js'
import { cleanTitle, stripTitleNoise } from './titles.js'
import { packMissionsMasonry } from './layout.js'
import { registrableDomain, subdomainPrefix } from './domains.js'
import { resolvePathGroup } from './path-groups.js'
import { render as preactRender, h } from './vendor/preact.mjs'
import htm from './vendor/htm.mjs'
import { Missions } from './components/Missions.js'
import { HeaderStats } from './components/HeaderStats.js'
import { getFilter } from './filter.js'

const html = htm.bind(h)

export let domainGroups = []

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
  const fav = tab.favIconUrl || ''
  if (fav.startsWith('data:')) return fav
  if (!tab.url) return ''
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
  faviconUrl.searchParams.set('pageUrl', tab.url)
  faviconUrl.searchParams.set('size', '32')
  return faviconUrl.toString()
}

/**
 * injectBreakPoints(str) — insert U+200B (zero-width space) into
 * long unbreakable tokens so the browser can wrap them without us
 * setting `word-break: break-all`. ZWSP is a Unicode break
 * opportunity that renders as nothing — no hyphen, no visible glyph,
 * just an invisible break point.
 *
 * Threshold: tokens of 15+ letters/digits/underscore get a ZWSP
 * inserted every 5 chars. Below that threshold, words pass through
 * untouched so natural-length English wraps at word boundaries and
 * short words never break mid-character.
 */
function injectBreakPoints(str) {
  if (!str) return str
  return str.replace(/[A-Za-z0-9_]{15,}/g, (token) => token.replace(/(.{5})(?=.)/g, '$1\u200B'))
}

/**
 * stripPgLabel(label, pgLabel) — build the chip title as a segment
 * array where EVERY occurrence of the pill label (as an exact
 * literal, nothing absorbed on either side) is replaced in place
 * by a placeholder object. Whatever characters follow the match
 * — a "@sha" commit hash, a "/tree/main" subpath, plain text —
 * are kept verbatim; only the label itself becomes the placeholder.
 * The char BEFORE the match must be a boundary (start of string or
 * a separator) so "label" inside "prelabel" isn't falsely matched.
 *
 *   prefix:   "owner/repo PR #4706"                   → [PH, " PR #4706"]
 *   suffix:   "Pull Request #4706 · owner/repo"       → ["Pull Request #4706 · ", PH]
 *   middle:   "PR #4706 · owner/repo · GitHub"        → ["PR #4706", " · ", PH, " · GitHub"]
 *   ref tail: "Size preview · owner/repo@296a5f1"     → ["Size preview", " · ", PH, "@296a5f1"]
 *   multi:    "owner/repo · log · owner/repo · PR"    → [PH, " · log", " · ", PH, " · PR"]
 *
 * Returns { segments, stripped }. When no boundary-preceded
 * occurrence is found, or when stripping would leave only
 * separators + placeholders (e.g. the title is just the label, or
 * label-sep-label with nothing else), the original label is
 * returned as a single-segment array and `stripped` is false.
 */
function stripPgLabel(label, pgLabel) {
  if (!pgLabel || !label || label === pgLabel) {
    return { segments: [label], stripped: false }
  }
  const seps = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const EL = esc(pgLabel)
  const SEP = '(?:' + seps.map(esc).join('|') + ')'
  const re = new RegExp(`(^|${SEP})(${EL})`, 'g')

  const hits = []
  let m
  while ((m = re.exec(label)) !== null) {
    hits.push({ index: m.index, length: m[0].length, prefixSep: m[1] })
    if (m.index === re.lastIndex) re.lastIndex++
  }
  if (hits.length === 0) return { segments: [label], stripped: false }

  const segments = []
  let cursor = 0
  for (const hit of hits) {
    const textBefore = label.slice(cursor, hit.index)
    if (textBefore) segments.push(textBefore)
    if (hit.prefixSep) segments.push(hit.prefixSep)
    segments.push({ placeholder: true })
    cursor = hit.index + hit.length
  }
  const textAfter = label.slice(cursor)
  if (textAfter) segments.push(textAfter)

  const hasText = segments.some((s) => typeof s === 'string' && s.trim())
  if (!hasText) return { segments: [label], stripped: false }

  return { segments, stripped: true }
}

/**
 * getFilteredCloseableUrls() — URLs of tabs the "Close N filtered tabs"
 * action would close: filter-matching, ungrouped, non-chrome. Returns []
 * when no filter is active. Shared between the HeaderStats button label
 * and the action handler in app.js so both see the same list.
 */
export function getFilteredCloseableUrls() {
  const q = getFilter()
  if (!q) return []
  return getRealTabs()
    .filter((t) => !isGroupedTab(t))
    .filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))
    .map((t) => t.url)
}

/**
 * renderHeaderStats() — (re)render the pinned-top stats row via Preact.
 *
 * One Preact render mounts a fresh <HeaderStats> tree into .header-stats;
 * all counts + action buttons come out of the same snapshot so the row
 * never shows inconsistent intermediate states (e.g. a stale "Close 3
 * filtered tabs" button lingering after the filter was cleared).
 *
 * Data sources — every count goes through computeDomainCardViewModel
 * so the header reads the same VM that drives the card grid. No more
 * DOM scraping for visibleDomains (`c.style.display !== 'none'`) or
 * dedupCount (`.action-btn text content`); if you trust the cards
 * are right, the header's right by construction.
 */
export function renderHeaderStats() {
  const mountEl = document.querySelector('.header-stats')
  if (!mountEl) return

  const realTabs = getRealTabs()
  const q = getFilter()
  const filtering = q.length > 0

  const visibleTabs = filtering ? realTabs.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)) : realTabs
  const totalWindows = new Set(realTabs.map((t) => t.windowId)).size
  const visibleWindows = new Set(visibleTabs.map((t) => t.windowId)).size

  const totalDomains = domainGroups.length
  let visibleDomains = 0
  let dedupCount = 0
  for (const g of domainGroups) {
    const vm = computeDomainCardViewModel(g, { filter: q, mode: 'matched' })
    if (vm.isHidden) continue
    visibleDomains++
    dedupCount += vm.closableExtras || 0
  }

  const filteredCloseCount = getFilteredCloseableUrls().length

  preactRender(
    html`<${HeaderStats}
      totalTabs=${realTabs.length}
      visibleTabs=${visibleTabs.length}
      totalWindows=${totalWindows}
      visibleWindows=${visibleWindows}
      totalDomains=${totalDomains}
      visibleDomains=${visibleDomains}
      dedupCount=${dedupCount}
      filteredCloseCount=${filteredCloseCount}
      hasCards=${totalDomains > 0}
      filtering=${filtering}
    />`,
    mountEl
  )
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
  const tokens = urls.map((u) => {
    try {
      const parsed = new URL(u)
      const t = parsed.pathname.split('/').filter(Boolean)
      if (parsed.search) t.push(parsed.search) // "?foo=bar"
      if (parsed.hash) t.push(parsed.hash) // "#section"
      return t
    } catch {
      return []
    }
  })
  const minLen = Math.min(...tokens.map((t) => t.length))

  let commonLead = 0
  for (let i = 0; i < minLen; i++) {
    const seg = tokens[0][i]
    if (tokens.every((t) => t[i] === seg)) commonLead = i + 1
    else break
  }

  let commonTrail = 0
  const maxTrail = minLen - commonLead
  for (let i = 1; i <= maxTrail; i++) {
    const seg = tokens[0][tokens[0].length - i]
    if (tokens.every((t) => t[t.length - i] === seg)) commonTrail = i
    else break
  }

  return tokens.map((t) => {
    const show = t.slice(commonLead, t.length - commonTrail)
    if (show.length === 0) return '/'
    // Path segments join with '/'; query/hash attach without a slash
    // (their leading sigil '?' or '#' is already a delimiter).
    let joined = ''
    for (const seg of show) {
      if (seg.startsWith('?') || seg.startsWith('#')) joined += seg
      else joined += (joined ? '/' : '') + seg
    }
    const firstIsPath = !show[0].startsWith('?') && !show[0].startsWith('#')
    const lead = commonLead > 0 ? '…' : ''
    return lead + (firstIsPath ? '/' : '') + joined
  })
}

/* ---- Domain card view-model ----
   Builds the per-card data consumed by <DomainCard>. Filtering used
   to be done imperatively in filter.js — walk each chip's DOM,
   toggle style.display, update each section-count, recompute the
   close-domain / dedup labels from per-card state. The whole thing
   is now inside this function: pass `{ filter, mode }` and get back
   a VM whose visibleChips / sections / closableCount already reflect
   the current filter scope.

     • filter — normalized (trim + lowercase) query string ('' means
                no filter)
     • mode   — 'matched' (keep tabs that match the filter) or
                'unmatched' (keep tabs that DON'T match; used for the
                secondary "Other tabs" grid). Empty filter in
                'unmatched' yields an all-hidden card — nothing can
                not-match an empty query.

   Returned fields:
     • isHidden     — true when the card has zero chips under the
                      current filter; <Missions> skips it entirely
     • displayMode  — 'normal' | 'unmatched'; <DomainCard> applies
                      the card-unmatched class + suppresses bulk-
                      close buttons when 'unmatched'
     • filtering    — convenience flag; sections/chips use it to
                      bypass the "+N more" overflow split so every
                      matching chip is visible at once
*/
function tabMatchesFilter(tab, filter) {
  if (!filter) return true
  const title = (tab.title || '').toLowerCase()
  const url = (tab.url || '').toLowerCase()
  return title.includes(filter) || url.includes(filter)
}

export function computeDomainCardViewModel(group, { filter = '', mode = 'matched' } = {}) {
  const allTabs = group.tabs || []
  const filtering = filter !== ''
  const displayMode = mode === 'unmatched' ? 'unmatched' : 'normal'
  const stableId = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')

  // First thing: narrow the tab set to what this grid should show.
  // Unfiltered matched mode keeps everything; unmatched mode with an
  // empty filter keeps nothing (secondary grid is hidden upstream in
  // that case anyway, but bail early so we don't produce a ghost
  // VM full of chips).
  const tabs =
    filtering
      ? allTabs.filter((t) => {
          const m = tabMatchesFilter(t, filter)
          return mode === 'unmatched' ? !m : m
        })
      : mode === 'unmatched'
        ? []
        : allTabs

  if (tabs.length === 0) {
    return { stableId, isHidden: true, displayMode, filtering }
  }

  const tabCount = tabs.length
  const isLanding = group.domain === '__landing-pages__'

  // Tabs in a Chrome group are preserved by bulk close / dedup actions.
  const closableTabs = tabs.filter((t) => !isGroupedTab(t))
  const closableCount = closableTabs.length

  // Count duplicates per URL, tracking grouped/ungrouped + which groups they're in.
  const dupeInfo = {} // { url: { total, ungrouped, groupIds: Set } }
  const urlCounts = {}
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1
    if (!dupeInfo[tab.url]) dupeInfo[tab.url] = { total: 0, ungrouped: 0, groupIds: new Set() }
    const info = dupeInfo[tab.url]
    info.total++
    if (isGroupedTab(tab)) info.groupIds.add(tab.groupId)
    else info.ungrouped++
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1)

  // Dedup policy (mirrors closeDuplicateTabs):
  //   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
  //   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
  //   • All grouped, single group → keep one, close the rest within that group.
  //   • All grouped, multi groups → skip (would empty a slot in each group).
  function closableForUrl(u) {
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

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set()
  const uniqueTabs = []
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url)
      uniqueTabs.push(tab)
    }
  }

  // Sort by title — the exact string the chip displays, so the visible
  // order never diverges from the sort order. Runs the full display
  // pipeline (stripTitleNoise → cleanTitle) per tab so what we compare
  // is what we render. `numeric: true` gives natural number ordering
  // (Dashboard 2 before Dashboard 11, PR #4488 before PR #4706).
  function sortLabel(tab) {
    let hostname = group.domain
    try {
      hostname = new URL(tab.url).hostname
    } catch {}
    return cleanTitle(stripTitleNoise(tab.title || ''), hostname).toLowerCase()
  }
  uniqueTabs.sort((a, b) => sortLabel(a).localeCompare(sortLabel(b), undefined, { numeric: true }))

  // Detect cross-subdomain shared paths — the "same page in dev2us +
  // dev11us + qaus" pattern that floods multi-env cards with near-
  // duplicates. A path (pathname + search + hash) present in 2+ named
  // subdomains gets folded into a single chip that carries an env-pill
  // stack; those tabs are then excluded from the per-subdomain sections
  // below so they don't appear twice.
  const foldedTabUrls = new Set()
  const foldGroups = [] // each entry is an array of tabs sharing the same path
  {
    const pathMap = new Map()
    for (const tab of uniqueTabs) {
      try {
        const parsed = new URL(tab.url)
        const sub = subdomainPrefix(parsed.hostname, group.domain)
        if (!sub) continue // root-level tabs have no env to compare
        const pathKey = parsed.pathname + parsed.search + parsed.hash
        if (!pathMap.has(pathKey)) pathMap.set(pathKey, [])
        pathMap.get(pathKey).push(tab)
      } catch {
        // unparseable URL — skip
      }
    }
    for (const tabs of pathMap.values()) {
      const subs = new Set()
      for (const t of tabs) {
        try {
          subs.add(subdomainPrefix(new URL(t.url).hostname, group.domain))
        } catch {}
      }
      if (subs.size < 2) continue
      foldGroups.push(tabs)
      tabs.forEach((t) => foldedTabUrls.add(t.url))
    }
  }

  // Group tabs by subdomain/port within the card, EXCLUDING any tabs
  // that got folded into the shared section above. Root tabs (no
  // subdomain or lone "www") sit under an empty-string key.
  const bySubdomain = new Map()
  for (const tab of uniqueTabs) {
    if (foldedTabUrls.has(tab.url)) continue
    let key = ''
    try {
      const parsed = new URL(tab.url)
      if (parsed.hostname === 'localhost' && parsed.port) {
        key = parsed.port
      } else {
        key = subdomainPrefix(parsed.hostname, group.domain)
      }
    } catch {}
    if (!bySubdomain.has(key)) bySubdomain.set(key, [])
    bySubdomain.get(key).push(tab)
  }

  // Sort policy: root tabs (empty key) first, then the rest
  // alphabetically by subdomain. Alphabetical is predictable — the
  // same subdomain always lands in the same spot across refreshes,
  // regardless of tab counts or Chrome tab-strip order.
  const sections = [...bySubdomain.entries()].sort((a, b) => {
    if (a[0] === b[0]) return 0
    if (a[0] === '') return -1
    if (b[0] === '') return 1
    return a[0].localeCompare(b[0])
  })
  const multipleSections = sections.length > 1
  // Single-subdomain card: hoist the subdomain up to a pill next to
  // the card title so chips don't repeat the prefix on every row.
  // Only for non-empty keys — all-root cards don't need a pill.
  const singleSubdomainKey = sections.length === 1 && sections[0][0] !== '' ? sections[0][0] : ''

  // Localhost cards use the port as the "subdomain" key (see the
  // bySubdomain loop above), so the pill / header for those should
  // render as `:3000` — prefix colon, no trailing dot — instead of
  // the FQDN-style `dev2us.` treatment. Flag it here so <DomainCard>
  // + <SubdomainSection> + the CSS pseudo-elements can branch.
  const isPortGroup = group.domain === 'localhost'
  const singleSubdomainIsPort = isPortGroup && !!singleSubdomainKey

  // Per-chip data builder. Closes over group + urlCounts so the
  // section loop below can call it without repeating context.
  // Returns the display-only fields <PageChip> needs — title,
  // favicon URL, tooltip, prefix/path/pg/dupe annotations. Phase 5
  // replaced the old renderChip HTML-string emitter with this
  // data-shape so components can render declaratively.
  function buildChipData(tab, showPrefix, pathSuffix, pathGroupLabel, stripLabel) {
    let parsed = null
    try {
      parsed = new URL(tab.url)
    } catch {}
    const hostname = parsed ? parsed.hostname : group.domain
    const label = cleanTitle(stripTitleNoise(tab.title || ''), hostname)
    let subPrefix = ''
    let portPrefix = ''
    if (parsed && showPrefix) {
      if (parsed.hostname === 'localhost' && parsed.port) portPrefix = parsed.port
      else subPrefix = subdomainPrefix(parsed.hostname, group.domain)
    }
    const leadPrefix = subPrefix || portPrefix
    const pgLabel = pathGroupLabel || ''
    const { segments: rawSegments, stripped: titleStripped } = stripPgLabel(label, stripLabel || pgLabel)
    // Inject zero-width spaces into long unbreakable tokens so the
    // browser can break them if layout needs to — without us setting
    // global `word-break: break-all` (which would also break SHORT
    // words awkwardly, e.g. "Highlight c / ode"). ZWSP is invisible
    // and doesn't render as a hyphen, so line-2 breaks on these long
    // tokens read as a clipped edge (the fade mask handles the
    // visual). Threshold 15 chars + every 5-char split keeps natural
    // English words (which are almost always <15 chars outside
    // "internationalization"-class outliers) intact and only tags
    // compound identifiers / usernames / hashes / slugs. Tooltip
    // keeps the unmodified string so copy-paste stays clean.
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    const tooltip = [leadPrefix, label, pathSuffix].filter(Boolean).join(' · ')
    const grouped = isGroupedTab(tab)
    return {
      tabUrl: tab.url,
      rawUrl: tab.rawUrl || tab.url,
      leadPrefix,
      pathGroupLabel: pgLabel,
      displaySegments,
      titleStripped,
      pathSuffix: pathSuffix || '',
      tooltip,
      dupeCount: urlCounts[tab.url] || 1,
      faviconUrl: pickFavicon(tab),
      isGrouped: grouped,
      groupDotColor: grouped ? groupDotColor(tab.groupId) : null,
      isApp: !!tab.isApp,
      envs: null
    }
  }

  // Per-section visible limit. With multiple subdomain sections in one
  // card, a global 8 would flood the card; 5 per section keeps each
  // sub-group scannable while the card stays compact.
  const CHIPS_PER_SECTION = 5

  // "+N more" collapses hidden chips behind an expander button. But
  // when N would be 1, the button itself takes about the same vertical
  // space as rendering the one chip inline — so the collapse saves
  // nothing. Roll that last chip into the visible set instead.
  //
  // While filtering we bypass the split entirely: every chip that
  // made it through the filter is, by definition, something the user
  // is trying to see. Collapsing any of them behind "+N more" would
  // defeat the filter. (Previously filter.js forced all .page-chips-
  // overflow elements to display:contents; the VM handles it now.)
  function splitForOverflow(tabs) {
    if (filtering || tabs.length <= CHIPS_PER_SECTION + 1) {
      return { vis: tabs, hid: [] }
    }
    return { vis: tabs.slice(0, CHIPS_PER_SECTION), hid: tabs.slice(CHIPS_PER_SECTION) }
  }

  // Folded (cross-env) chip data — one chip representing the same path
  // present in 2+ subdomains. The env-pill stack replaces the usual
  // subdomain prefix; clicking a pill focuses that env's tab and the
  // chip's close button (handled in PageChip) closes every env copy.
  function buildFoldedChipData(tabs) {
    const primary = tabs[0]
    let parsed = null
    try {
      parsed = new URL(primary.url)
    } catch {}
    const hostname = parsed ? parsed.hostname : group.domain
    const label = cleanTitle(stripTitleNoise(primary.title || ''), hostname)
    const { segments: rawSegments, stripped: titleStripped } = stripPgLabel(label, '')
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    // Sort envs by prefix with numeric-aware compare so dev2us lands
    // before dev11us (plain lexicographic would give dev11us, dev2us,
    // qaus — technically right but wrong for a human-natural read).
    // Stable across refreshes since `tabs` is derived from the same
    // pathMap + subdomain prefix every time.
    const envs = tabs
      .map((t) => {
        let sub = ''
        try {
          sub = subdomainPrefix(new URL(t.url).hostname, group.domain)
        } catch {}
        return { prefix: sub || '?', tabUrl: t.url, rawUrl: t.rawUrl || t.url }
      })
      .sort((a, b) => a.prefix.localeCompare(b.prefix, undefined, { numeric: true }))
    const tooltip = [envs.map((e) => e.prefix).join(' · '), label].filter(Boolean).join(' · ')
    return {
      tabUrl: primary.url,
      rawUrl: primary.rawUrl || primary.url,
      leadPrefix: '',
      pathGroupLabel: '',
      displaySegments,
      titleStripped,
      pathSuffix: '',
      tooltip,
      dupeCount: 1,
      faviconUrl: pickFavicon(primary),
      isGrouped: false,
      groupDotColor: null,
      // Folded chip reads as "app" only when every env tab behind it
      // is running in an app window — a mixed set isn't clearly one
      // or the other, so we bias toward "not app" (no dashed marker).
      isApp: tabs.every((t) => t.isApp),
      envs
    }
  }

  // Assemble the shared section (appears first in the card when any
  // fold groups exist). It's a virtual subdomain: one flat list of
  // folded chips, no cluster sub-sections. Close-section closes every
  // tab across every env in every fold group.
  let sharedSectionData = null
  if (foldGroups.length > 0) {
    const sortedFolds = foldGroups.slice().sort((a, b) => sortLabel(a[0]).localeCompare(sortLabel(b[0]), undefined, { numeric: true }))
    const foldedChipData = sortedFolds.map((tabs) => buildFoldedChipData(tabs))
    const { vis, hid } = splitForOverflow(foldedChipData)
    const sharedClosableUrls = sortedFolds.flatMap((tabs) => tabs.filter((t) => !isGroupedTab(t)).map((t) => t.url))
    const totalFoldedTabs = sortedFolds.reduce((sum, tabs) => sum + tabs.length, 0)
    sharedSectionData = {
      key: '__shared__',
      sectionCount: totalFoldedTabs,
      sectionClosableUrls: sharedClosableUrls,
      showHeader: true,
      isShared: true,
      hasFlat: true,
      flatVisibleChips: vis,
      flatHiddenChips: hid,
      flatHiddenCount: hid.length,
      clusters: []
    }
  }

  const sectionsData = sections.map(([key, sectionTabs]) => {
    // Header appears only when a card has 2+ subdomain sections AND
    // the section isn't the empty-key "root" (card title already says
    // the root). When shown, the header replaces the per-chip prefix —
    // repeating "dev2ca" on every chip under a "dev2ca" header is noise.
    const showHeader = multipleSections && key !== ''
    // Suppress chip prefix whenever the subdomain info is shown
    // elsewhere — either a section header (multi-subdomain card) or
    // the card-title pill (single-subdomain card).
    const showChipPrefix = !showHeader && !singleSubdomainKey

    // Title-collision disambiguation: if two tabs in this section
    // render with the same visible title, append the smallest path
    // crumb that tells them apart. Noiseless for the common case
    // (no collision → empty string → <PageChip> skips the crumb span).
    const pathByUrl = new Map()
    const sameTitle = new Map()
    for (const t of sectionTabs) {
      const titleKey = stripTitleNoise(t.title || '').toLowerCase()
      if (!sameTitle.has(titleKey)) sameTitle.set(titleKey, [])
      sameTitle.get(titleKey).push(t)
    }
    for (const collided of sameTitle.values()) {
      if (collided.length < 2) continue
      const suffixes = disambiguatingPaths(collided.map((t) => t.url))
      collided.forEach((t, i) => pathByUrl.set(t.url, suffixes[i]))
    }

    // Path-group pills: resolve each tab's path group (github repo,
    // jira project, contentful env, etc.) and only keep labels whose
    // group has ≥2 members in this section. A lone group is usually
    // silent clutter — the signal is "these belong together," which
    // takes at least two chips to convey.
    //
    // Exception: adapters can opt in to `alwaysCluster: true` to
    // bypass the threshold. Jira uses this so ticket keys stay as
    // their own cluster even at member-count 1 — a self-contained
    // identifier and, more importantly, a position-stable anchor.
    // (Closing one of a two-member cluster without the flag would
    // suddenly drop the survivor into the flat section; with it, the
    // cluster persists in place.)
    //
    // Extra guardrail: drop labels that equal the subdomain or the
    // card domain (redundant information already carried by the
    // section header or card title).
    const pgByUrl = new Map()
    const pgKeyCount = new Map()
    for (const t of sectionTabs) {
      const pg = resolvePathGroup(t.url)
      if (!pg) continue
      pgByUrl.set(t.url, pg)
      pgKeyCount.set(pg.key, (pgKeyCount.get(pg.key) || 0) + 1)
    }
    const pgLabelByUrl = new Map()
    for (const [url, pg] of pgByUrl) {
      if (!pg.alwaysCluster && pgKeyCount.get(pg.key) < 2) continue
      if (pg.label === key || pg.label === group.domain) continue
      pgLabelByUrl.set(url, pg.label)
    }

    // Build cluster blocks (≥2 members share a path-group label) and
    // a singleton block. Clusters render as labeled sub-sections; the
    // pill becomes the header and inner chips skip their per-chip
    // pill. Singletons follow flat with no header. Each block manages
    // its OWN visible/hidden split and its OWN "+N more" expander —
    // when a cluster overflows, expansion happens inside the cluster
    // so hidden members never leave their header's visual context.
    const clusterByLabel = new Map()
    const singletonTabs = []
    for (const t of sectionTabs) {
      const lbl = pgLabelByUrl.get(t.url)
      if (!lbl) {
        singletonTabs.push(t)
        continue
      }
      if (!clusterByLabel.has(lbl)) clusterByLabel.set(lbl, [])
      clusterByLabel.get(lbl).push(t)
    }
    const sortedClusters = [...clusterByLabel.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))

    // Order chips within a cluster by sub-category (if the adapter
    // provided one), then by their display-label order (preserved via
    // stable sort, since sectionTabs was already sorted by display
    // label above). Unknown categories fall to 'other'.
    const CATEGORY_ORDER = { pull: 0, issue: 1, commit: 2, code: 3, other: 4 }

    // Pull requests deserve their own section under a repo: they're
    // action items ("review me"), not browsing state ("I'm reading
    // this file"). Splitting them into a sibling sub-cluster lets
    // each half claim its own CHIPS_PER_SECTION limit instead of
    // fighting over one — 10 total visible for a PR-heavy repo
    // instead of 5 with the rest hidden behind "+N more".
    //
    // Threshold: split only when the PR side has ≥2 tabs AND the
    // non-PR side has ≥1. A single PR stays folded into the main
    // cluster; a repo with only PRs stays as one section (and
    // cosmetically still gets the PR label via `isPR`).
    const rawClusters = []
    for (const [lbl, tabs] of sortedClusters) {
      const prTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category === 'pull')
      const nonPrTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category !== 'pull')
      if (prTabs.length >= 2 && nonPrTabs.length >= 1) {
        rawClusters.push({ label: lbl, tabs: nonPrTabs, key: lbl, isPR: false })
        rawClusters.push({ label: lbl, tabs: prTabs, key: lbl + ':pr', isPR: true })
      } else {
        const allArePRs = prTabs.length === tabs.length && tabs.length > 0
        rawClusters.push({ label: lbl, tabs, key: lbl, isPR: allArePRs })
      }
    }

    // Per-cluster data objects. <PathgroupSection> handles the
    // header (pill + count + rule + close button), visible/hidden
    // chip split, and local expand state. <PageChip> consumes the
    // chip-data objects directly (Phase 5).
    const clusters = rawClusters.map(({ label, tabs, key, isPR }) => {
      const orderedTabs = tabs.slice().sort((a, b) => {
        const aCat = CATEGORY_ORDER[pgByUrl.get(a.url)?.category] ?? CATEGORY_ORDER.other
        const bCat = CATEGORY_ORDER[pgByUrl.get(b.url)?.category] ?? CATEGORY_ORDER.other
        return aCat - bCat
      })
      const { vis, hid } = splitForOverflow(orderedTabs)
      const clusterClosable = orderedTabs.filter((t) => !isGroupedTab(t))
      const visibleChips = vis.map((t) => buildChipData(t, showChipPrefix, pathByUrl.get(t.url) || '', '', label))
      const hiddenChips = hid.map((t) => buildChipData(t, showChipPrefix, pathByUrl.get(t.url) || '', '', label))
      return {
        key,
        label,
        isPR,
        count: tabs.length,
        closableUrls: clusterClosable.map((t) => t.url),
        visibleChips,
        hiddenChips,
        hiddenCount: hid.length
      }
    })

    // Flat singletons: split into visible + hidden chip-data arrays.
    const { vis: flatVis, hid: flatHid } = splitForOverflow(singletonTabs)
    const flatVisibleChips = flatVis.map((t) => buildChipData(t, showChipPrefix, pathByUrl.get(t.url) || '', ''))
    const flatHiddenChips = flatHid.map((t) => buildChipData(t, showChipPrefix, pathByUrl.get(t.url) || '', ''))

    // Closable URLs for the subdomain-level close button in the
    // SubdomainSection header (shown only on multi-subdomain cards,
    // where the header itself is visible). Filters out tabs already
    // in a Chrome tab group — matches the preserveGroups semantics
    // used elsewhere. Union of every chip's URL in this section.
    const sectionClosableUrls = sectionTabs.filter((t) => !isGroupedTab(t)).map((t) => t.url)

    return {
      key,
      sectionCount: sectionTabs.length,
      sectionClosableUrls,
      showHeader,
      isShared: false,
      isPort: isPortGroup,
      hasFlat: singletonTabs.length > 0,
      flatVisibleChips,
      flatHiddenChips,
      flatHiddenCount: flatHid.length,
      clusters
    }
  })

  // Prepend the cross-env fold section so it sits above the per-
  // subdomain sections — it reads as a TL;DR of "these pages are the
  // same across your envs, you probably want to see them grouped."
  if (sharedSectionData) sectionsData.unshift(sharedSectionData)

  // Labels derived for the Preact component to consume directly.
  // closableCountLabel mirrors the original "Close all N tabs" vs
  // "Close N ungrouped tabs" split so the button text matches.
  const closableCountLabel =
    closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`

  const dupeUrlsEncoded = closableDupeUrls.map((url) => encodeURIComponent(url)).join(',')

  const displayName = isLanding ? 'Homepages' : group.label || group.domain.replace(/^www\./, '')

  // In the secondary ("unmatched") grid, every bulk-close action is
  // suppressed — we don't want to offer a "Close 4 tabs" on a card
  // rendered as the user's NON-match set, that would close the tabs
  // they didn't type "github" about. Zero out the closable fields so
  // the buttons just don't render (components are already conditional
  // on closableCount > 0 / closableUrls.length > 0).
  const isUnmatched = displayMode === 'unmatched'
  const vmClosableCount = isUnmatched ? 0 : closableCount
  const vmClosableExtras = isUnmatched ? 0 : closableExtras
  const vmClosableDupeUrls = isUnmatched ? [] : closableDupeUrls
  const vmDupeUrlsEncoded = isUnmatched ? '' : dupeUrlsEncoded
  const vmSections = isUnmatched
    ? sectionsData.map((s) => ({
        ...s,
        sectionClosableUrls: [],
        clusters: s.clusters.map((c) => ({ ...c, closableUrls: [] }))
      }))
    : sectionsData

  return {
    stableId,
    isHidden: false,
    displayMode,
    filtering,
    isLanding,
    tabCount,
    closableCount: vmClosableCount,
    closableCountLabel,
    closableDupeUrls: vmClosableDupeUrls,
    closableExtras: vmClosableExtras,
    dupeUrlsEncoded: vmDupeUrlsEncoded,
    singleSubdomainKey,
    singleSubdomainIsPort,
    displayName,
    sections: vmSections
  }
}

/* ---- Main render ---- */
export async function renderStaticDashboard() {
  await fetchOpenTabs()
  const realTabs = getRealTabs()

  // Group tabs by domain. Landing pages (Gmail inbox, X home, etc.) get
  // their own special group so they can be closed together without
  // affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) => !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com', pathExact: ['/home'] },
    { hostname: 'www.linkedin.com', pathExact: ['/'] },
    { hostname: 'github.com', pathExact: ['/'] },
    { hostname: 'www.youtube.com', pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists).
    // config.local.js is a classic script; its globals are on window.
    ...(window.LOCAL_LANDING_PAGE_PATTERNS || [])
  ]

  function isLandingPage(url) {
    try {
      const parsed = new URL(url)
      return LANDING_PAGE_PATTERNS.some((p) => {
        const hostnameMatch = p.hostname ? parsed.hostname === p.hostname : p.hostnameEndsWith ? parsed.hostname.endsWith(p.hostnameEndsWith) : false
        if (!hostnameMatch) return false
        if (p.test) return p.test(parsed.pathname, url)
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix)
        if (p.pathExact) return p.pathExact.includes(parsed.pathname)
        return parsed.pathname === '/'
      })
    } catch {
      return false
    }
  }

  domainGroups = []
  const groupMap = {}
  const landingTabs = []

  // Custom group rules from config.local.js (if any)
  const customGroups = window.LOCAL_CUSTOM_GROUPS || []

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url)
      return (
        customGroups.find((r) => {
          const hostMatch = r.hostname ? parsed.hostname === r.hostname : r.hostnameEndsWith ? parsed.hostname.endsWith(r.hostnameEndsWith) : false
          if (!hostMatch) return false
          if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix)
          return true
        }) || null
      )
    } catch {
      return null
    }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab)
        continue
      }

      const customRule = matchCustomGroup(tab.url)
      if (customRule) {
        const key = customRule.groupKey
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] }
        groupMap[key].tabs.push(tab)
        continue
      }

      let hostname
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files'
      } else {
        hostname = new URL(tab.url).hostname
      }
      if (!hostname) continue

      // Roll up subdomains so dev1.foo.com + dev2.foo.com share one
      // card. registrableDomain() is a no-op for IPs, localhost, and
      // user-space suffixes like user.github.io — see domains.js.
      const key = registrableDomain(hostname)
      if (!groupMap[key]) groupMap[key] = { domain: key, tabs: [] }
      groupMap[key].tabs.push(tab)
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs }
  }

  // Sort: landing pages first, then domains from landing-page sites, then by tab count.
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map((p) => p.hostname).filter(Boolean))
  const landingSuffixes = LANDING_PAGE_PATTERNS.map((p) => p.hostnameEndsWith).filter(Boolean)
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true
    return landingSuffixes.some((s) => domain.endsWith(s))
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__'
    const bIsLanding = b.domain === '__landing-pages__'
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1

    const aIsPriority = isLandingDomain(a.domain)
    const bIsPriority = isLandingDomain(b.domain)
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1

    return b.tabs.length - a.tabs.length
  })

  // Snapshot current card order so the next render preserves it.
  // Phase 2 retired prevColumns (Preact's keyed reconciliation preserves
  // the .domain-block DOM node so layout.js's data-masonry-col survives).
  // Phase 3/4 retired expand-state snapshots (<FlatSection> and
  // <PathgroupSection> own their expand state via useState). Only the
  // top-level block order still needs a hint here: it's what domainGroups
  // is sorted against below.
  const openTabsMissionsEl = document.getElementById('openTabsMissions')
  const prevOrder = new Map()
  if (openTabsMissionsEl) {
    let idx = 0
    for (const c of openTabsMissionsEl.querySelectorAll('.domain-block')) {
      const id = c.dataset.domainId
      if (!id) continue
      prevOrder.set(id, idx++)
    }
  }

  // Stable re-sort: previously-seen cards keep their prior order; new
  // cards stay where the landing/priority/tab-count sort put them (at
  // the end, since `return 0` preserves Array.prototype.sort stability).
  const stableDomainId = (g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-')
  domainGroups.sort((a, b) => {
    const aPrev = prevOrder.get(stableDomainId(a))
    const bPrev = prevOrder.get(stableDomainId(b))
    if (aPrev !== undefined && bPrev !== undefined) return aPrev - bPrev
    if (aPrev !== undefined) return -1
    if (bPrev !== undefined) return 1
    return 0
  })

  mountMissions()
}

/**
 * mountMissions() — (re)render both card grids using the current
 * filter state. Called both from the top-level renderStaticDashboard
 * (after fetchOpenTabs + grouping) and from filter.js after the filter
 * query changes (no fetch needed — domainGroups is already fresh).
 *
 * Each DomainCard re-computes its VM from (group, filter, mode), so
 * filter changes flow through the component tree the same way tab
 * changes do: new VM → Preact diff → DOM update. No imperative
 * hide/show walks; filter.js stays a thin listener layer.
 *
 * The secondary ("Other tabs") grid is only rendered while a filter
 * is active; its wrapper's visibility follows whether any card has
 * unmatched content to show.
 */
export function mountMissions() {
  const openTabsSection = document.getElementById('openTabsSection')
  const openTabsMissionsEl = document.getElementById('openTabsMissions')
  const openTabsMissionsUnmatchedEl = document.getElementById('openTabsMissionsUnmatched')
  const secondaryWrap = document.getElementById('openTabsMissionsOther')
  if (!openTabsMissionsEl) return

  const filter = getFilter()

  if (openTabsSection) openTabsSection.style.display = 'block'

  preactRender(html`<${Missions} domains=${domainGroups} filter=${filter} mode="matched" />`, openTabsMissionsEl)

  if (openTabsMissionsUnmatchedEl) {
    if (filter) {
      preactRender(html`<${Missions} domains=${domainGroups} filter=${filter} mode="unmatched" />`, openTabsMissionsUnmatchedEl)
    } else {
      preactRender(null, openTabsMissionsUnmatchedEl)
    }
  }

  // Wrapper visibility follows "does secondary actually have any
  // card to show?" — computed from the same VM logic, so the decision
  // stays consistent with what <Missions> rendered above.
  if (secondaryWrap) {
    const hasUnmatched = !!filter && domainGroups.some((g) => !computeDomainCardViewModel(g, { filter, mode: 'unmatched' }).isHidden)
    secondaryWrap.style.display = hasUnmatched ? '' : 'none'
  }

  if (domainGroups.length > 0) packMissionsMasonry({ unpin: true })
  renderHeaderStats()
}
