// Paste this into the DevTools console on a Tab Out extension page.
// Read-only: it does not open, close, move, group, or delete anything.
// It strips query strings and hashes by default so the copied report is easier to share.

(async () => {
  const CONFIG = {
    weeks: 4,
    maxHistoryResults: 3000,
    maxExactVisitLookups: 3000,
    exactVisitConcurrency: 12,
    topRows: 40,
    includeQuery: false,
    includeTitles: true,
    copyToClipboard: true,
    downloadFile: true,
    printTables: false,
    printProgress: false
  }

  const chromeApi = globalThis.chrome
  if (!chromeApi?.tabs?.query || !chromeApi?.bookmarks?.getTree || !chromeApi?.history?.search || !chromeApi?.history?.getVisits) {
    console.error('Run this from the DevTools console on a Tab Out extension page, not from a normal website.')
    return
  }

  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  const startTime = now - CONFIG.weeks * 7 * DAY
  const pinnedStorageKey = 'tabOutPinnedDomainsV1'
  const publicSuffixes = new Set([
    'github.io',
    'gitlab.io',
    'bitbucket.io',
    'pages.dev',
    'workers.dev',
    'vercel.app',
    'netlify.app',
    'netlify.com',
    'herokuapp.com',
    'firebaseapp.com',
    'web.app',
    'appspot.com',
    'azurewebsites.net',
    'ngrok.io',
    'ngrok-free.app',
    'loca.lt',
    'surge.sh',
    'blogspot.com',
    'wordpress.com',
    'tumblr.com',
    'co.uk',
    'co.jp',
    'co.kr',
    'co.nz',
    'co.in',
    'com.au',
    'com.br',
    'com.cn',
    'com.mx',
    'ac.uk',
    'gov.uk',
    'edu.au'
  ])
  const trackingParamPatterns = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i, /^mc_cid$/i, /^mc_eid$/i]

  function isUsefulUrl(url) {
    try {
      return ['http:', 'https:', 'file:'].includes(new URL(url).protocol)
    } catch {
      return false
    }
  }

  function registrableDomain(hostname) {
    if (!hostname) return ''
    const clean = hostname.replace(/^www\./, '')
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return clean
    const parts = clean.split('.')
    if (parts.length <= 2) return clean
    const lastTwo = parts.slice(-2).join('.')
    if (publicSuffixes.has(lastTwo)) return parts.slice(-3).join('.')
    return parts.slice(-2).join('.')
  }

  function domainFromUrl(url) {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return 'local-files'
    return registrableDomain(parsed.hostname)
  }

  function subdomainFromUrl(url, domain) {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:' || parsed.hostname === domain) return ''
    const suffix = `.${domain}`
    if (!parsed.hostname.endsWith(suffix)) return ''
    const prefix = parsed.hostname.slice(0, -suffix.length)
    return prefix === 'www' ? '' : prefix
  }

  function canonicalUrl(url) {
    const parsed = new URL(url)
    parsed.hash = ''
    if (!CONFIG.includeQuery) {
      parsed.search = ''
    } else {
      for (const key of [...parsed.searchParams.keys()]) {
        if (trackingParamPatterns.some((pattern) => pattern.test(key))) parsed.searchParams.delete(key)
      }
    }
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.toString()
  }

  function displayPath(url) {
    try {
      const parsed = new URL(url)
      return `${parsed.pathname || '/'}${CONFIG.includeQuery ? parsed.search : ''}` || '/'
    } catch {
      return ''
    }
  }

  function displayDate(time) {
    return time ? new Date(time).toISOString().slice(0, 10) : ''
  }

  function flattenBookmarks(nodes, folderPath = []) {
    const rows = []
    for (const node of nodes || []) {
      const nextPath = node.title ? [...folderPath, node.title] : folderPath
      if (node.url) {
        rows.push({
          url: node.url,
          title: node.title || '',
          folder: folderPath.filter(Boolean).join(' / ') || '(root)'
        })
      }
      if (node.children) rows.push(...flattenBookmarks(node.children, nextPath))
    }
    return rows
  }

  function ensure(map, key, create) {
    if (!map.has(key)) map.set(key, create())
    return map.get(key)
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let index = 0
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
          const current = index++
          results[current] = await fn(items[current], current)
        }
      })
    )
    return results
  }

  function scorePage(page) {
    const ageDays = page.lastVisitTime ? Math.floor((now - page.lastVisitTime) / DAY) : 999
    const recencyBoost = Math.max(0, 14 - ageDays)
    return page.tabCount * 8 + page.bookmarkCount * 5 + page.historyVisits * 3 + page.typedVisits * 4 + recencyBoost
  }

  function scoreDomain(domain) {
    return domain.openTabs * 8 + domain.bookmarks * 2 + domain.historyVisits * 2 + domain.typedVisits * 3 + domain.pages.size
  }

  async function writeTextToClipboard(text) {
    let clipboardError = null
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch (error) {
        clipboardError = error
      }
    }
    if (typeof globalThis.copy === 'function') {
      globalThis.copy(text)
      return
    }
    throw clipboardError || new Error('No clipboard API available')
  }

  function downloadTextFile(filename, text, mimeType = 'application/json') {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const [tabs, bookmarkTree, historyItems, storedPins] = await Promise.all([
    chromeApi.tabs.query({}),
    chromeApi.bookmarks.getTree(),
    chromeApi.history.search({ text: '', startTime, endTime: now, maxResults: CONFIG.maxHistoryResults }),
    chromeApi.storage?.local?.get ? chromeApi.storage.local.get(pinnedStorageKey).catch(() => ({})) : {}
  ])

  const bookmarkRows = flattenBookmarks(bookmarkTree).filter((row) => isUsefulUrl(row.url))
  const historyRows = historyItems.filter((item) => item.url && isUsefulUrl(item.url))
  const historyVisitTargets = historyRows.slice(0, CONFIG.maxExactVisitLookups)
  const pinnedDomains = Array.isArray(storedPins?.[pinnedStorageKey]) ? storedPins[pinnedStorageKey] : []
  const exactVisitsByUrl = new Map()

  if (CONFIG.printProgress) console.log(`Reading exact visit counts for ${historyVisitTargets.length} history URLs from the last ${CONFIG.weeks} weeks...`)
  await mapLimit(historyVisitTargets, CONFIG.exactVisitConcurrency, async (item, index) => {
    if (CONFIG.printProgress && index > 0 && index % 250 === 0) console.log(`...checked ${index}/${historyVisitTargets.length}`)
    try {
      const visits = await chromeApi.history.getVisits({ url: item.url })
      const recentVisits = visits.filter((visit) => visit.visitTime >= startTime && visit.visitTime <= now)
      exactVisitsByUrl.set(item.url, {
        visits: recentVisits.length,
        typedVisits: recentVisits.filter((visit) => visit.transition === 'typed' || visit.transition === 'keyword').length,
        lastVisitTime: Math.max(item.lastVisitTime || 0, ...recentVisits.map((visit) => visit.visitTime || 0))
      })
    } catch {
      exactVisitsByUrl.set(item.url, {
        visits: 0,
        typedVisits: 0,
        lastVisitTime: item.lastVisitTime || 0
      })
    }
  })

  const pages = new Map()
  const domains = new Map()

  function addPage({ url, title = '', source, folder = '', visitCount = 0, typedCount = 0, lastVisitTime = 0, windowId = null }) {
    if (!isUsefulUrl(url)) return
    const safeUrl = canonicalUrl(url)
    const domain = domainFromUrl(safeUrl)
    const subdomain = subdomainFromUrl(safeUrl, domain)
    const page = ensure(pages, safeUrl, () => ({
      url: safeUrl,
      domain,
      path: displayPath(safeUrl),
      title: CONFIG.includeTitles ? title || '' : '',
      tabCount: 0,
      bookmarkCount: 0,
      historyVisits: 0,
      typedVisits: 0,
      lastVisitTime: 0,
      windows: new Set(),
      bookmarkFolders: new Set(),
      subdomains: new Set()
    }))
    if (CONFIG.includeTitles && !page.title && title) page.title = title
    if (source === 'tab') {
      page.tabCount += 1
      if (windowId != null) page.windows.add(windowId)
    }
    if (source === 'bookmark') {
      page.bookmarkCount += 1
      if (folder) page.bookmarkFolders.add(folder)
    }
    if (source === 'history') {
      page.historyVisits += visitCount
      page.typedVisits += typedCount
      page.lastVisitTime = Math.max(page.lastVisitTime, lastVisitTime)
    }
    if (subdomain) page.subdomains.add(subdomain)

    const domainRow = ensure(domains, domain, () => ({
      domain,
      openTabs: 0,
      bookmarks: 0,
      historyVisits: 0,
      typedVisits: 0,
      lastVisitTime: 0,
      pages: new Set(),
      windows: new Set(),
      bookmarkFolders: new Set(),
      subdomains: new Set()
    }))
    domainRow.pages.add(safeUrl)
    if (source === 'tab') {
      domainRow.openTabs += 1
      if (windowId != null) domainRow.windows.add(windowId)
    }
    if (source === 'bookmark') {
      domainRow.bookmarks += 1
      if (folder) domainRow.bookmarkFolders.add(folder)
    }
    if (source === 'history') {
      domainRow.historyVisits += visitCount
      domainRow.typedVisits += typedCount
      domainRow.lastVisitTime = Math.max(domainRow.lastVisitTime, lastVisitTime)
    }
    if (subdomain) domainRow.subdomains.add(subdomain)
  }

  for (const tab of tabs) addPage({ url: tab.url || '', title: tab.title || '', source: 'tab', windowId: tab.windowId })
  for (const bookmark of bookmarkRows) addPage({ ...bookmark, source: 'bookmark' })
  for (const item of historyRows) {
    const exact = exactVisitsByUrl.get(item.url)
    addPage({
      url: item.url,
      title: item.title || '',
      source: 'history',
      visitCount: exact?.visits ?? 1,
      typedCount: exact?.typedVisits ?? 0,
      lastVisitTime: exact?.lastVisitTime || item.lastVisitTime || 0
    })
  }

  const domainSummary = [...domains.values()]
    .map((domain) => ({
      domain: domain.domain,
      score: scoreDomain(domain),
      pinned: pinnedDomains.includes(domain.domain),
      openTabs: domain.openTabs,
      historyVisits: domain.historyVisits,
      typedVisits: domain.typedVisits,
      bookmarks: domain.bookmarks,
      uniquePages: domain.pages.size,
      windows: domain.windows.size,
      subdomains: domain.subdomains.size,
      bookmarkFolders: domain.bookmarkFolders.size,
      lastSeen: displayDate(domain.lastVisitTime)
    }))
    .sort((a, b) => b.score - a.score)

  const topPages = [...pages.values()]
    .map((page) => ({
      score: scorePage(page),
      domain: page.domain,
      path: page.path,
      title: page.title,
      openTabs: page.tabCount,
      historyVisits: page.historyVisits,
      typedVisits: page.typedVisits,
      bookmarks: page.bookmarkCount,
      windows: page.windows.size,
      bookmarkFolders: [...page.bookmarkFolders].slice(0, 4),
      subdomains: [...page.subdomains].slice(0, 6),
      lastSeen: displayDate(page.lastVisitTime),
      url: page.url
    }))
    .sort((a, b) => b.score - a.score)

  const recommendations = {
    pinDomains: domainSummary
      .filter((row) => !row.pinned && row.domain !== 'local-files' && (row.openTabs >= 2 || row.historyVisits >= 12 || row.score >= 35))
      .slice(0, 12)
      .map((row) => ({ domain: row.domain, reason: `${row.openTabs} open tabs, ${row.historyVisits} recent visits, ${row.bookmarks} bookmarks`, score: row.score })),
    bookmarkOrShortcut: topPages
      .filter((row) => row.historyVisits >= 4 && row.bookmarks === 0)
      .slice(0, 20)
      .map((row) => ({ domain: row.domain, path: row.path, title: row.title, historyVisits: row.historyVisits, typedVisits: row.typedVisits, url: row.url })),
    dedupeOpenTabs: topPages
      .filter((row) => row.openTabs > 1)
      .slice(0, 20)
      .map((row) => ({ openTabs: row.openTabs, domain: row.domain, path: row.path, title: row.title, url: row.url })),
    subdomainWorkspaces: [...domains.values()]
      .filter((domain) => domain.subdomains.size >= 2 && (domain.openTabs > 0 || domain.historyVisits >= 6))
      .map((domain) => ({
        domain: domain.domain,
        subdomains: [...domain.subdomains].sort().slice(0, 12),
        openTabs: domain.openTabs,
        historyVisits: domain.historyVisits
      }))
      .sort((a, b) => b.openTabs + b.historyVisits - (a.openTabs + a.historyVisits))
      .slice(0, 12),
    consolidateBookmarkFolders: [...domains.values()]
      .filter((domain) => domain.bookmarks >= 3 && domain.bookmarkFolders.size >= 2)
      .map((domain) => ({
        domain: domain.domain,
        bookmarks: domain.bookmarks,
        folders: [...domain.bookmarkFolders].sort().slice(0, 8)
      }))
      .sort((a, b) => b.bookmarks - a.bookmarks)
      .slice(0, 12),
    staleBookmarks: topPages
      .filter((row) => row.bookmarks > 0 && row.historyVisits === 0 && row.openTabs === 0)
      .slice(0, 20)
      .map((row) => ({ domain: row.domain, path: row.path, title: row.title, bookmarkFolders: row.bookmarkFolders, url: row.url })),
    lowValueOpenTabs: topPages
      .filter((row) => row.openTabs > 0 && row.historyVisits <= 1 && row.bookmarks === 0)
      .slice(0, 20)
      .map((row) => ({ openTabs: row.openTabs, domain: row.domain, path: row.path, title: row.title, url: row.url }))
  }

  const report = {
    generatedAt: new Date(now).toISOString(),
    range: {
      weeks: CONFIG.weeks,
      start: new Date(startTime).toISOString(),
      end: new Date(now).toISOString()
    },
    counts: {
      openTabs: tabs.filter((tab) => isUsefulUrl(tab.url || '')).length,
      bookmarkUrls: bookmarkRows.length,
      historyUrls: historyRows.length,
      exactHistoryUrlsChecked: historyVisitTargets.length,
      pinnedDomains: pinnedDomains.length
    },
    pinnedDomains,
    domainSummary: domainSummary.slice(0, CONFIG.topRows),
    topPages: topPages.slice(0, CONFIG.topRows),
    recommendations,
    notes: [
      'Queries and hashes are stripped unless CONFIG.includeQuery is true.',
      'historyVisits counts visits inside the configured time range for checked history URLs.',
      'No browser state was changed.'
    ]
  }

  globalThis.tabOutUsageReport = report
  globalThis.tabOutUsageReportJson = JSON.stringify(report, null, 2)
  globalThis.tabOutUsageReportCompactJson = JSON.stringify(report)

  if (CONFIG.printTables) {
    console.group(`Tab Out usage audit: last ${CONFIG.weeks} weeks`)
    console.table(report.domainSummary)
    console.table(report.topPages)
    console.table(report.recommendations.pinDomains)
    console.table(report.recommendations.bookmarkOrShortcut)
    console.table(report.recommendations.dedupeOpenTabs)
    console.table(report.recommendations.subdomainWorkspaces)
    console.table(report.recommendations.consolidateBookmarkFolders)
    console.table(report.recommendations.staleBookmarks)
    console.table(report.recommendations.lowValueOpenTabs)
    console.groupEnd()
  }

  if (CONFIG.downloadFile) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    const filename = `tab-out-usage-report-${stamp}.json`
    downloadTextFile(filename, globalThis.tabOutUsageReportJson)
    console.log(`Downloaded ${filename}. Attach or paste that file back into Codex for a concrete organization plan.`)
  }

  if (CONFIG.copyToClipboard) {
    try {
      await writeTextToClipboard(globalThis.tabOutUsageReportJson)
      console.log('Copied the same JSON report to clipboard.')
    } catch (error) {
      console.warn('Could not copy automatically. Run copy(tabOutUsageReportJson) in this console.', error)
    }
  }

  return report
})()
