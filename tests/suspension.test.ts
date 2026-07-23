import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { registerDashboardRefresh } from '../src/extension/dashboard-controller.js'
import { suspendChipTarget, suspendDomainTabs, suspendExactTabTargets, suspendHistoryEntry } from '../src/extension/tab-actions.js'
import { createSuspendTargetStore, extractSuspenderId, buildSuspendUrl, isSuspended, rememberSuspendTargetFromTabs, unwrapSuspenderUrl, unwrapSuspenderTitle } from '../src/extension/suspension.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

const SUSPENDER_ID = 'aaaabbbbccccddddeeeeffffgggghhhh'
const TEMPLATE = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=Old%20Title&pos=0&uri=https://old.example/page`
function createSharedLockManager() {
  let tail = Promise.resolve()
  return {
    request<Value>(_name: string, task: () => Promise<Value>): Promise<Value> {
      const result = tail.then(task)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    async drain(): Promise<void> {
      await tail
    }
  }
}

test('isSuspended: true only for a suspender-rewritten url pair, derived or supplied', () => {
  assert.equal(isSuspended(TEMPLATE, 'https://old.example/page'), true)
  assert.equal(isSuspended(TEMPLATE), true)
  assert.equal(isSuspended('https://old.example/page', 'https://old.example/page'), false)
  assert.equal(isSuspended('https://old.example/page'), false)
  assert.equal(isSuspended(''), false)
  assert.equal(isSuspended(undefined), false)
})

test('extractSuspenderId: returns the id for a suspended.html url', () => {
  assert.equal(extractSuspenderId(TEMPLATE), SUSPENDER_ID)
})

test('extractSuspenderId: null for non-suspended extension pages and other urls', () => {
  assert.equal(extractSuspenderId(`chrome-extension://${SUSPENDER_ID}/options.html`), null)
  assert.equal(extractSuspenderId('https://example.com'), null)
  assert.equal(extractSuspenderId(''), null)
  assert.equal(extractSuspenderId(undefined), null)
})

test('buildSuspendUrl: round-trips through the unwrap helpers', () => {
  const url = 'https://example.com/path?x=1&y=2#frag'
  const title = 'Hello & Goodbye #1 café'
  const built = buildSuspendUrl({ id: SUSPENDER_ID, template: TEMPLATE }, { url, title })
  assert.equal(unwrapSuspenderUrl(built), url)
  assert.equal(unwrapSuspenderTitle(built), title)
})

test('buildSuspendUrl: preserves the suspender base path and extra fragment params', () => {
  const built = buildSuspendUrl(
    { id: SUSPENDER_ID, template: TEMPLATE },
    { url: 'https://new.example', title: 'New' }
  )
  assert.ok(built.startsWith(`chrome-extension://${SUSPENDER_ID}/suspended.html#`))
  assert.ok(built.includes('pos=0'))
  assert.ok(built.endsWith('&uri=https://new.example'))
})

test('buildSuspendUrl: zeroes the template pos= scroll offset', () => {
  const template = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=Old&pos=4220&uri=https://old.example/page`
  const built = buildSuspendUrl({ id: SUSPENDER_ID, template }, { url: 'https://new.example', title: 'New' })
  assert.ok(built.includes('&pos=0&'))
  assert.ok(!built.includes('pos=4220'))
})

test('getSuspendTarget: a slow stored read cannot overwrite a target learned from live tabs', async () => {
  const storedId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const liveId = 'cccccccccccccccccccccccccccccccc'
  const storedTemplate = `chrome-extension://${storedId}/suspended.html#ttl=Stored&pos=0&uri=https://stored.example`
  const liveTemplate = `chrome-extension://${liveId}/suspended.html#ttl=Live&pos=0&uri=https://live.example`
  let resolveStoredRead!: (value: unknown) => void
  let markStoredReadStarted!: () => void
  const storedRead = new Promise<unknown>((resolve) => {
    resolveStoredRead = resolve
  })
  const storedReadStarted = new Promise<void>((resolve) => {
    markStoredReadStarted = resolve
  })
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => {
      markStoredReadStarted()
      return storedRead
    },
    runExclusive: (task) => task(),
    write: async () => {}
  })

  const pendingStoredTarget = store.get()
  await storedReadStarted

  store.rememberFromTabs([{ suspended: true, rawUrl: liveTemplate }])
  resolveStoredRead({ id: storedId, template: storedTemplate })

  assert.deepEqual(await pendingStoredTarget, { id: liveId, template: liveTemplate })
  assert.deepEqual(await store.get(), { id: liveId, template: liveTemplate })
})

test('rememberSuspendTargetFromTabs: persistence keeps the newest target when an older write is slow', async () => {
  const olderId = 'dddddddddddddddddddddddddddddddd'
  const newerId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const olderTemplate = `chrome-extension://${olderId}/suspended.html#ttl=Older&pos=0&uri=https://older.example`
  const newerTemplate = `chrome-extension://${newerId}/suspended.html#ttl=Newer&pos=0&uri=https://newer.example`
  const lockManager = createSharedLockManager()
  let releaseOlderWrite!: () => void
  let markOlderWriteStarted!: () => void
  let markWritesCompleted!: () => void
  const olderWriteGate = new Promise<void>((resolve) => {
    releaseOlderWrite = resolve
  })
  const olderWriteStarted = new Promise<void>((resolve) => {
    markOlderWriteStarted = resolve
  })
  const writesCompleted = new Promise<void>((resolve) => {
    markWritesCompleted = resolve
  })
  let writeCount = 0
  let completedWriteCount = 0
  let storedTarget: unknown = null
  let now = 1_000
  const store = createSuspendTargetStore({
    now: () => ++now,
    read: async () => storedTarget,
    runExclusive: (task) => lockManager.request('suspend-target', task),
    write: async (value) => {
      writeCount += 1
      if (writeCount === 1) {
        markOlderWriteStarted()
        await olderWriteGate
      }
      storedTarget = value
      completedWriteCount += 1
      if (completedWriteCount === 2) markWritesCompleted()
    }
  })

  store.rememberFromTabs([{ suspended: true, rawUrl: olderTemplate }])
  await olderWriteStarted

  store.rememberFromTabs([{ suspended: true, rawUrl: newerTemplate }])
  releaseOlderWrite()
  await writesCompleted

  assert.deepEqual(
    storedTarget && typeof storedTarget === 'object'
      ? { id: (storedTarget as Record<string, unknown>).id, template: (storedTarget as Record<string, unknown>).template }
      : storedTarget,
    { id: newerId, template: newerTemplate }
  )
  assert.equal(Number.isFinite((storedTarget as Record<string, unknown>).observedAt), true)
  assert.deepEqual(await store.get(), { id: newerId, template: newerTemplate })
})

test('suspend-target persistence does not write when the current generation cannot be read', async () => {
  const lockManager = createSharedLockManager()
  let writeCount = 0
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => { throw new Error('storage unavailable') },
    runExclusive: (task) => lockManager.request('suspend-target', task),
    write: async () => { writeCount += 1 }
  })

  store.rememberFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  await lockManager.drain()

  assert.equal(writeCount, 0)
  assert.deepEqual(await store.get(), { id: SUSPENDER_ID, template: TEMPLATE })
})

test('suspend-target persistence keeps a newer stored observation', async () => {
  const lockManager = createSharedLockManager()
  let writeCount = 0
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => ({ id: 'newer', template: 'chrome-extension://newer/suspended.html', observedAt: 2_000 }),
    runExclusive: (task) => lockManager.request('suspend-target', task),
    write: async () => { writeCount += 1 }
  })

  store.rememberFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  await lockManager.drain()

  assert.equal(writeCount, 0)
})

test('separate extension contexts cannot let an older trailing suspend target overwrite the newest observation', async () => {
  const lockManager = createSharedLockManager()
  let observationCount = 0
  let storedTarget: { id: string; template: string; observedAt: number } | undefined
  let releaseFirstWrite!: () => void
  let markFirstWriteStarted!: () => void
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve
  })
  let writeCount = 0
  const createStore = () => createSuspendTargetStore({
    now: () => {
      observationCount += 1
      return 1_001
    },
    read: async () => storedTarget,
    runExclusive: (task) => lockManager.request('suspend-target', task),
    write: async (value) => {
      writeCount += 1
      if (writeCount === 1) {
        markFirstWriteStarted()
        await firstWriteGate
      }
      storedTarget = value
    }
  })
  const contextA = createStore()
  const contextB = createStore()
  const oldestId = '11111111111111111111111111111111'
  const olderId = '22222222222222222222222222222222'
  const newestId = '33333333333333333333333333333333'
  const suspendedUrl = (id: string) => `chrome-extension://${id}/suspended.html#ttl=Page&pos=0&uri=https://example.test/${id}`

  contextA.rememberFromTabs([{ suspended: true, rawUrl: suspendedUrl(oldestId) }])
  await firstWriteStarted
  contextA.rememberFromTabs([{ suspended: true, rawUrl: suspendedUrl(olderId) }])
  contextB.rememberFromTabs([{ suspended: true, rawUrl: suspendedUrl(newestId) }])
  assert.equal(observationCount, 3)

  releaseFirstWrite()
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await lockManager.drain()
  }

  assert.equal(storedTarget?.id, newestId)
  assert.equal(storedTarget?.template, suspendedUrl(newestId))
})

test('rememberSuspendTargetFromTabs: captures the first suspended tab; getSuspendTarget returns it', async () => {
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => null,
    runExclusive: (task) => task(),
    write: async () => {}
  })
  const raw = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=T&pos=0&uri=https://kept.example`
  store.rememberFromTabs([
    { suspended: false, rawUrl: 'https://live.example' },
    { suspended: true, rawUrl: raw }
  ])
  const target = await store.get()
  assert.deepEqual(target, { id: SUSPENDER_ID, template: raw })
})

test('rememberSuspendTargetFromTabs: ignores non-suspender and non-suspended tabs', async () => {
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => null,
    runExclusive: (task) => task(),
    write: async () => {}
  })
  const good = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=T&pos=0&uri=https://good.example`
  store.rememberFromTabs([{ suspended: true, rawUrl: good }])
  // A later scan whose only "suspended" tab is a non-suspender URL (plus a live
  // tab) must NOT overwrite the previously-learned target.
  store.rememberFromTabs([
    { suspended: true, rawUrl: 'https://not-a-suspender.example' },
    { suspended: false, rawUrl: 'https://live.example' }
  ])
  assert.deepEqual(await store.get(), { id: SUSPENDER_ID, template: good })
})

test('rememberSuspendTargetFromTabs: same-suspender template drift updates memory without re-persisting', async () => {
  const lockManager = createSharedLockManager()
  const otherId = 'iiiijjjjkkkkllllmmmmnnnnoooopppp'
  const setCalls: unknown[] = []
  let storedTarget: unknown = null
  const store = createSuspendTargetStore({
    now: () => 1_000,
    read: async () => storedTarget,
    runExclusive: (task) => lockManager.request('suspend-target', task),
    write: async (value) => {
      storedTarget = value
      setCalls.push(value)
    }
  })
  const first = `chrome-extension://${otherId}/suspended.html#ttl=A&pos=10&uri=https://a.example`
  const second = `chrome-extension://${otherId}/suspended.html#ttl=B&pos=99&uri=https://b.example`
  store.rememberFromTabs([{ suspended: true, rawUrl: first }])
  await lockManager.drain()
  assert.equal(setCalls.length, 1)
  store.rememberFromTabs([{ suspended: true, rawUrl: second }])
  await lockManager.drain()
  assert.equal(setCalls.length, 1)
  assert.deepEqual(await store.get(), { id: otherId, template: second })
})

test('suspend actions report unknown without mutating or refreshing when live tabs cannot be read', async () => {
  const url = 'https://example.test/docs'
  const tabs = [{
    id: 7,
    url,
    title: 'Docs',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    index: 0
  }] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  const updateCalls: number[] = []
  const updateTab = api.tabs.update
  api.tabs.update = async (tabId, properties) => {
    updateCalls.push(tabId)
    return updateTab(tabId, properties)
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  api.tabs.query = async () => {
    throw new Error('Tab inventory unavailable')
  }
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })

  try {
    const dashboardTab = {
      id: 7,
      url,
      rawUrl: url,
      suspended: false,
      title: 'Docs',
      favIconUrl: '',
      windowId: 1,
      active: false,
      pinned: false,
      groupId: -1,
      isTabOut: false,
      isApp: false
    }
    const domainResult = await suspendDomainTabs({
      group: { domain: 'example.test', tabs: [dashboardTab] },
      filter: ''
    })
    const exactResult = await suspendExactTabTargets({
      targets: [{ tabId: 7, tabUrl: url }]
    })
    const chipResult = await suspendChipTarget({ tabUrl: url })
    const historyResult = await suspendHistoryEntry({ tabUrl: url })

    assert.deepEqual(domainResult, { ok: false, suspendedCount: 0 })
    assert.deepEqual(exactResult, { ok: false, suspendedCount: 0 })
    assert.equal(chipResult, false)
    assert.equal(historyResult, 'unknown')
    assert.deepEqual(updateCalls, [])
    assert.equal(refreshCount, 0)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('suspend actions report failure without refreshing when every tab update fails', async () => {
  const url = 'https://example.test/docs'
  const tabs = [{
    id: 7,
    url,
    title: 'Docs',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    index: 0
  }] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  let updateAttempts = 0
  api.tabs.update = async () => {
    updateAttempts += 1
    throw new Error('Tab update unavailable')
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount

  try {
    const dashboardTab = {
      id: 7,
      url,
      rawUrl: url,
      suspended: false,
      title: 'Docs',
      favIconUrl: '',
      windowId: 1,
      active: false,
      pinned: false,
      groupId: -1,
      isTabOut: false,
      isApp: false
    }
    const domainResult = await suspendDomainTabs({
      group: { domain: 'example.test', tabs: [dashboardTab] },
      filter: ''
    })
    const exactResult = await suspendExactTabTargets({
      targets: [{ tabId: 7, tabUrl: url }]
    })
    const chipResult = await suspendChipTarget({ tabUrl: url })

    assert.deepEqual(domainResult, { ok: false, suspendedCount: 0 })
    assert.deepEqual(exactResult, { ok: false, suspendedCount: 0 })
    assert.equal(chipResult, false)
    assert.equal(updateAttempts, 3)
    assert.equal(tabs[0]?.url, url)
    assert.equal(refreshCount, refreshBaseline)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('suspendExactTabTargets preserves and refreshes confirmed partial updates', async () => {
  const firstUrl = 'https://example.test/first'
  const secondUrl = 'https://example.test/second'
  const tabs = [
    { id: 7, url: firstUrl, title: 'First', windowId: 1, active: false, pinned: false, groupId: -1, index: 0 },
    { id: 8, url: secondUrl, title: 'Second', windowId: 1, active: false, pinned: false, groupId: -1, index: 1 }
  ] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  const updateTab = api.tabs.update
  api.tabs.update = async (tabId, properties) => {
    if (tabId === 8) throw new Error('Tab update unavailable')
    return updateTab(tabId, properties)
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount

  try {
    const result = await suspendExactTabTargets({
      targets: [
        { tabId: 7, tabUrl: firstUrl },
        { tabId: 8, tabUrl: secondUrl }
      ]
    })

    assert.deepEqual(result, { ok: false, suspendedCount: 1 })
    assert.equal(unwrapSuspenderUrl(tabs[0]?.url), firstUrl)
    assert.notEqual(tabs[0]?.url, firstUrl)
    assert.equal(tabs[1]?.url, secondUrl)
    assert.equal(refreshCount, refreshBaseline + 1)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('suspendExactTabTargets skips a later target that navigates while earlier updates settle', async () => {
  const firstUrl = 'https://example.test/first'
  const secondUrl = 'https://example.test/second'
  const navigatedUrl = 'https://example.test/navigated'
  const tabs = [
    { id: 7, url: firstUrl, title: 'First', windowId: 1, active: false, pinned: false, groupId: -1, index: 0 },
    { id: 8, url: secondUrl, title: 'Second', windowId: 1, active: false, pinned: false, groupId: -1, index: 1 }
  ] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  const updateTab = api.tabs.update
  let updateAttempts = 0
  api.tabs.update = async (tabId, properties) => {
    updateAttempts += 1
    const updated = await updateTab(tabId, properties)
    if (tabId === 7) {
      tabs[1] = { ...tabs[1], url: navigatedUrl, title: 'Navigated' }
    }
    return updated
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount

  try {
    const result = await suspendExactTabTargets({
      targets: [
        { tabId: 7, tabUrl: firstUrl },
        { tabId: 8, tabUrl: secondUrl }
      ]
    })

    assert.deepEqual(result, { ok: false, suspendedCount: 1 })
    assert.equal(unwrapSuspenderUrl(tabs[0]?.url), firstUrl)
    assert.equal(tabs[1]?.url, navigatedUrl)
    assert.equal(updateAttempts, 1)
    assert.equal(refreshCount, refreshBaseline + 1)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('suspendExactTabTargets skips a later target with an uncommitted navigation', async () => {
  const firstUrl = 'https://example.test/first'
  const secondUrl = 'https://example.test/second'
  const pendingUrl = 'https://example.test/pending'
  const tabs = [
    { id: 7, url: firstUrl, title: 'First', windowId: 1, active: false, pinned: false, groupId: -1, index: 0 },
    { id: 8, url: secondUrl, title: 'Second', windowId: 1, active: false, pinned: false, groupId: -1, index: 1 }
  ] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  const updateTab = api.tabs.update
  let updateAttempts = 0
  api.tabs.update = async (tabId, properties) => {
    updateAttempts += 1
    const updated = await updateTab(tabId, properties)
    if (tabId === 7) tabs[1] = { ...tabs[1], pendingUrl }
    return updated
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount

  try {
    const result = await suspendExactTabTargets({
      targets: [
        { tabId: 7, tabUrl: firstUrl },
        { tabId: 8, tabUrl: secondUrl }
      ]
    })

    assert.deepEqual(result, { ok: false, suspendedCount: 1 })
    assert.equal(unwrapSuspenderUrl(tabs[0]?.url), firstUrl)
    assert.equal(tabs[1]?.url, secondUrl)
    assert.equal(tabs[1]?.pendingUrl, pendingUrl)
    assert.equal(updateAttempts, 1)
    assert.equal(refreshCount, refreshBaseline + 1)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('suspendChipTarget resolves and mutates with one live-tab inventory read', async () => {
  const url = 'https://example.test/docs'
  const tabs = [{
    id: 7,
    url,
    title: 'Docs',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    index: 0
  }] as chrome.tabs.Tab[]
  const api = createFakeChromeApi({ tabs })
  const queryTabs = api.tabs.query.bind(api.tabs)
  let queryCount = 0
  api.tabs.query = async (queryInfo = {}) => {
    queryCount += 1
    return queryTabs(queryInfo)
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = api as unknown as typeof globalThis.chrome
  setChromeTabsApi(api)
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: TEMPLATE }])
  let refreshCount = 0
  const unregisterRefresh = registerDashboardRefresh(() => {
    refreshCount += 1
  })

  try {
    assert.equal(await suspendChipTarget({ tabUrl: url }), true)
    assert.equal(queryCount, 1)
    assert.equal(refreshCount, 1)
    assert.equal(unwrapSuspenderUrl(tabs[0]?.url), url)
    assert.notEqual(tabs[0]?.url, url)
  } finally {
    unregisterRefresh()
    setChromeTabsApi(null)
    if (previousChrome) globalThis.chrome = previousChrome
    else delete (globalThis as { chrome?: unknown }).chrome
  }
})
