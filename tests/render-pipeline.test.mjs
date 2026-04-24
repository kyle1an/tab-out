import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { flattenBookmarkNodes } from '../extension/bookmarks.js'
import { filterInputFromSearch, titleForFilterInput, urlForFilterInput } from '../extension/components/App.js'
import { isFilterFocusShortcut } from '../extension/components/HeaderBar.js'
import { buildDashboardViewModel, buildDomainGroups, computeDomainCardViewModel } from '../extension/render.js'

globalThis.chrome = {
  runtime: {
    getURL(path) {
      return `chrome-extension://tab-out${path}`
    }
  }
}

globalThis.window = {
  LOCAL_PATH_GROUPERS: [],
  LOCAL_CUSTOM_GROUPS: []
}

/**
 * @param {Partial<import('../extension/types').DashboardTab> & { url: string }} overrides
 * @returns {import('../extension/types').DashboardTab}
 */
function makeTab(overrides) {
  return {
    id: 1,
    url: overrides.url,
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: overrides.title || '',
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: overrides.isApp || false,
    index: overrides.index,
    ...overrides
  }
}

test('buildDomainGroups keeps homepage routes inside their native domain cards', () => {
  const tabs = [
    makeTab({ url: 'https://github.com/', title: 'GitHub' }),
    makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' })
  ]

  const groups = buildDomainGroups(tabs)

  const githubGroup = groups.find((group) => group.domain === 'github.com')
  assert.ok(githubGroup)
  assert.deepEqual(githubGroup.tabs.map((tab) => tab.url), ['https://github.com/', 'https://github.com/openai/openai'])
})

test('buildDomainGroups orders normal domain cards by tab count', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://github.com/', title: 'GitHub' }),
    makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' }),
    makeTab({ id: 3, url: 'https://openai.com/research', title: 'Research' }),
    makeTab({ id: 4, url: 'https://openai.com/api', title: 'API' })
  ])

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['github.com', 'openai.com']
  )
})

test('buildDomainGroups puts pinned domain cards above higher-count normal cards', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://github.com/', title: 'GitHub' }),
      makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' }),
      makeTab({ id: 3, url: 'https://openai.com/research', title: 'Research' })
    ],
    { pinnedDomains: ['openai.com'] }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['openai.com', 'github.com']
  )
  assert.equal(groups[0].pinned, true)
  assert.equal(groups[1].pinned, false)
})

test('buildDomainGroups keeps saved pin order ahead of previous card order', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://github.com/', title: 'GitHub' }),
      makeTab({ id: 2, url: 'https://openai.com/research', title: 'Research' }),
      makeTab({ id: 3, url: 'https://example.com/docs', title: 'Docs' })
    ],
    {
      pinnedDomains: ['example.com', 'openai.com'],
      previousOrder: new Map([
        ['domain-github-com', 0],
        ['domain-openai-com', 1],
        ['domain-example-com', 2]
      ])
    }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['example.com', 'openai.com', 'github.com']
  )
})

test('buildDomainGroups keeps system cards ahead of pinned domain cards', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://openai.com/research', title: 'Research' }),
      makeTab({ id: 2, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', isApp: true }),
      makeTab({ id: 3, url: 'chrome-extension://tab-out/index.html', rawUrl: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true })
    ],
    { pinnedDomains: ['openai.com'] }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['__tab-out__', '__standalone-apps__', 'openai.com']
  )
})

test('buildDomainGroups collects standalone app tabs into a dedicated apps card', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', isApp: true }),
    makeTab({ id: 2, url: 'https://calendar.google.com/calendar/u/0/r', title: 'Calendar', isApp: true }),
    makeTab({ id: 3, url: 'https://github.com/openai/openai', title: 'openai/openai' })
  ])

  const appsGroup = groups.find((group) => group.domain === '__standalone-apps__')
  assert.ok(appsGroup)
  assert.equal(appsGroup.label, 'Apps')
  assert.deepEqual(
    appsGroup.tabs.map((tab) => tab.url),
    ['https://mail.google.com/mail/u/0/', 'https://calendar.google.com/calendar/u/0/r']
  )

  const appsVm = computeDomainCardViewModel(appsGroup)
  assert.equal(appsVm.displayName, 'Apps')
  assert.equal(appsVm.tabCountLabel, '2')
  assert.equal(appsVm.tabCountTitle, '2 open tabs')
  assert.equal(appsVm.sections[0].flatVisibleChips.every((chip) => chip.iconOnly), true)

  const filteredAppsVm = computeDomainCardViewModel(appsGroup, { filter: 'inbox' })
  assert.equal(filteredAppsVm.tabCountLabel, '1/2')
  assert.equal(filteredAppsVm.tabCountTitle, '1 of 2 open tabs shown while filtering')
})

test('buildDomainGroups collects Tab Out pages into a dedicated new tabs card', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'chrome-extension://tab-out/index.html', rawUrl: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true }),
    makeTab({ id: 2, url: 'chrome://newtab/', rawUrl: 'chrome://newtab/', title: 'New Tab', isTabOut: true }),
    makeTab({
      id: 3,
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      rawUrl: 'chrome-extension://tab-out/index.html?focusFilter=1',
      title: 'Tab Out',
      isTabOut: true
    }),
    makeTab({ id: 4, url: 'https://openai.com/', title: 'OpenAI' })
  ])

  const newTabsGroup = groups.find((group) => group.domain === '__tab-out__')
  assert.ok(newTabsGroup)
  assert.equal(newTabsGroup.label, 'New tabs')
  assert.deepEqual(
    newTabsGroup.tabs.map((tab) => tab.rawUrl),
    ['chrome-extension://tab-out/index.html', 'chrome://newtab/', 'chrome-extension://tab-out/index.html?focusFilter=1']
  )
})

test('computeDomainCardViewModel keeps pinned new tabs out of close and dedupe counts', () => {
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true,
        pinned: true
      }),
      makeTab({
        id: 2,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true
      }),
      makeTab({
        id: 3,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.displayName, 'New tabs')
  assert.equal(vm.closableCount, 2)
  assert.equal(vm.closableExtras, 2)
})

test('computeDomainCardViewModel disambiguates collisions by rendered title', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/team/dashboard', title: 'Dashboard - Example' }),
      makeTab({ id: 2, url: 'https://example.com/me/dashboard', title: 'Dashboard' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.isHidden, false)

  const chips = vm.sections[0].flatVisibleChips
  assert.equal(chips.length, 2)
  assert.deepEqual(new Set(chips.map((chip) => chip.pathSuffix)), new Set(['/me', '/team']))
})

test('computeDomainCardViewModel keeps the shared folded section headerless', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://dev.example.com/settings', title: 'Settings' }),
      makeTab({ id: 2, url: 'https://qa.example.com/settings', title: 'Settings' }),
      makeTab({ id: 3, url: 'https://dev.example.com/logs', title: 'Logs' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.isHidden, false)
  assert.equal(vm.sections[0].isShared, true)
  assert.equal(vm.sections[0].showHeader, false)
  assert.equal(vm.sections[0].flatVisibleChips.length, 1)
  assert.deepEqual(
    vm.sections[0].flatVisibleChips[0].envs.map((env) => env.prefix),
    ['dev', 'qa']
  )
})

test('buildDashboardViewModel derives matched and unmatched cards in one pass', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://alpha.example.com/overview', title: 'Overview' }),
    makeTab({ id: 2, url: 'https://alpha.example.com/beta', title: 'Beta rollout' }),
    makeTab({ id: 3, url: 'https://second.test.com/other', title: 'Other page' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'beta'
  })

  assert.equal(vm.stats.totalTabs, 3)
  assert.equal(vm.stats.visibleTabs, 1)
  assert.equal(vm.matchedCards.length, 1)
  assert.equal(vm.unmatchedCards.length, 2)
  assert.equal(vm.showOtherTabs, true)
  assert.deepEqual(vm.filteredCloseUrls, ['https://alpha.example.com/beta'])
  assert.equal(vm.matchedCards[0].vm.tabCount, 1)
  assert.equal(vm.matchedCards[0].vm.totalTabCount, 2)
  assert.equal(vm.matchedCards[0].vm.tabCountLabel, '1/2')
  assert.equal(vm.matchedCards[0].vm.tabCountTitle, '1 of 2 open tabs shown while filtering')

  const unmatchedAlphaCard = vm.unmatchedCards.find(({ group }) => group.domain === 'example.com')
  assert.equal(unmatchedAlphaCard.vm.tabCount, 1)
  assert.equal(unmatchedAlphaCard.vm.totalTabCount, 2)
  assert.equal(unmatchedAlphaCard.vm.tabCountLabel, '1/2')
})

test('titleForFilterInput mirrors typed filter keywords', () => {
  assert.equal(titleForFilterInput('github'), 'github - Tab Out')
  assert.equal(titleForFilterInput('  qa env  '), 'qa env - Tab Out')
  assert.equal(titleForFilterInput(''), '\u200e')
  assert.equal(titleForFilterInput('   '), '\u200e')
})

test('filter URL helpers preserve restorable filter state without history churn', () => {
  assert.equal(filterInputFromSearch('?filter=github'), 'github')
  assert.equal(filterInputFromSearch('?focusFilter=1&filter=qa+env'), 'qa env')
  assert.equal(urlForFilterInput('github', { pathname: '/index.html', search: '?focusFilter=1', hash: '#top' }), '/index.html?focusFilter=1&filter=github#top')
  assert.equal(urlForFilterInput('', { pathname: '/index.html', search: '?filter=github&focusFilter=1', hash: '' }), '/index.html?focusFilter=1')
  assert.equal(urlForFilterInput('qa env', { pathname: '/index.html', search: '', hash: '' }), '/index.html?filter=qa+env')
})

test('filter focus shortcut matches Cmd+K on macOS and Ctrl+K elsewhere', () => {
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true }, 'MacIntel'), true)
  assert.equal(isFilterFocusShortcut({ key: 'K', ctrlKey: true }, 'Win32'), true)
  assert.equal(isFilterFocusShortcut({ key: 'k', ctrlKey: true }, 'Linux x86_64'), true)
  assert.equal(isFilterFocusShortcut({ key: 'k', ctrlKey: true }, 'MacIntel'), false)
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true }, 'Win32'), false)
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true, shiftKey: true }, 'MacIntel'), false)
  assert.equal(isFilterFocusShortcut({ key: 'j', metaKey: true }, 'MacIntel'), false)
})

test('filtering ignores Tab Out keywords injected by the active filter title and URL', () => {
  const groups = buildDomainGroups([
    makeTab({
      url: 'chrome-extension://tab-out/index.html?filter=github',
      rawUrl: 'chrome-extension://tab-out/index.html?filter=github',
      title: 'github - Tab Out',
      isTabOut: true
    }),
    makeTab({ id: 2, url: 'https://openai.com/', title: 'OpenAI' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'github'
  })

  assert.equal(vm.stats.visibleTabs, 0)
  assert.equal(vm.matchedCards.length, 0)
})

test('flattenBookmarkNodes turns bookmark tree nodes into read-only dashboard items', () => {
  const bookmarks = flattenBookmarkNodes([
    {
      id: '1',
      title: 'Root',
      children: [
        { id: '2', title: 'OpenAI', url: 'https://openai.com/' },
        {
          id: '3',
          title: 'Nested',
          children: [{ id: '4', title: 'GitHub', url: 'https://github.com/' }]
        }
      ]
    }
  ])

  assert.deepEqual(
    bookmarks.map((bookmark) => ({ url: bookmark.url, sourceType: bookmark.sourceType })),
    [
      { url: 'https://openai.com/', sourceType: 'bookmark' },
      { url: 'https://github.com/', sourceType: 'bookmark' }
    ]
  )
})

test('buildDashboardViewModel disables destructive actions for bookmarks source', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://bookmarks.test/a', title: 'Bookmark A', sourceType: 'bookmark' }),
    makeTab({ id: 2, url: 'https://bookmarks.test/b', title: 'Bookmark B', sourceType: 'bookmark' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    source: 'bookmarks'
  })

  assert.equal(vm.source, 'bookmarks')
  assert.equal(vm.stats.dedupCount, 0)
  assert.deepEqual(vm.filteredCloseUrls, [])
  assert.equal(vm.matchedCards[0].vm.closableCount, 0)
  assert.equal(vm.matchedCards[0].vm.sections[0].flatVisibleChips.every((chip) => chip.sourceType === 'bookmark'), true)
})

test('manifest keeps only the permissions used by the extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.permissions, ['tabs', 'tabGroups', 'bookmarks', 'storage', 'favicon'])
  assert.equal(manifest.commands['switch-to-last-tab'].description, 'Switch to the previous tab in global activation history')
  assert.equal(manifest.commands['switch-to-next-tab'].description, 'Switch forward to the next tab in global activation history')
  assert.equal(manifest.commands['open-filter-tab'].description, 'Open Tab Out with the filter focused')
})
