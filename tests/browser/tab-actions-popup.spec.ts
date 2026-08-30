import { expect, test, type Page } from '@playwright/test'

const POPUP_FIXTURE = '/tests/fixtures/tab-actions-popup.html'

const DEDUPE_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="dedupe-button"]'
const CLOSE_SUSPENDED_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="close-suspended-button"]'
const COMBINED_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="close-suspended-and-dedupe-button"]'
const MOVE_CURRENT_TAB_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="move-current-tab-button"]'
const SELECT_NATIVE_PROFILE_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="select-native-profile-button"]'
const MERGE_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="merge-desktop-windows-button"]'

async function enableMergeAvailability(page: Page) {
  await page.evaluate(() => {
    Reflect.set(window, '__tabOutPopupMessageHandler', (message: { type?: string } | undefined) => {
      if (message?.type === 'tab-out:get-desktop-window-merge-status') {
        return { ok: true, availability: { available: true }, session: null }
      }
      return undefined
    })
    const onMessage = Reflect.get(window.chrome.runtime, 'onMessage') as unknown as {
      dispatch: (message: unknown) => void
    }
    onMessage.dispatch({ type: 'tab-out:desktop-window-merge-status-changed' })
  })
  await expect(page.locator(MERGE_ITEM)).not.toHaveAttribute('disabled', '')
}

test('popup renders the Tab Actions Menu and dedupes all windows from a live count', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(POPUP_FIXTURE)

  const dedupeItem = page.locator(DEDUPE_ITEM)
  const closeItem = page.locator(CLOSE_SUSPENDED_ITEM)
  const combinedItem = page.locator(COMBINED_ITEM)
  const mergeItem = page.locator(MERGE_ITEM)
  await expect(dedupeItem).toHaveText('Dedupe duplicate tabs')
  await expect(dedupeItem).toBeDisabled()
  await expect(closeItem).toHaveText('Close all suspended tabs')
  await expect(closeItem).toBeEnabled()
  await expect(combinedItem).toHaveText('Close all suspended tabs and dedupe')
  await expect(combinedItem).toBeEnabled()
  const moveItem = page.locator(MOVE_CURRENT_TAB_ITEM)
  await expect(moveItem).toHaveText('Move current tab to new window')
  await expect(moveItem).toBeEnabled()
  await expect(mergeItem).toContainText('Merge windows on this desktop…')
  await expect(mergeItem).toBeDisabled()
  await expect(mergeItem).toContainText('Window merge coordination is unavailable in this Chrome session')
  await expect(mergeItem.getByText('Merge windows on this desktop…', { exact: true })).toHaveCSS('font-size', '14px')
  await expect(mergeItem.getByText('Window merge coordination is unavailable in this Chrome session', { exact: true })).toHaveCSS('font-size', '13px')
  const separator = page.locator('[data-tabout="tab-actions"] [role="separator"]')
  await expect(separator).toHaveCount(1)

  await page.evaluate(async () => {
    const duplicateUrl = 'https://duplicate.example.test/docs'
    await window.chrome.tabs.create({ active: false, url: duplicateUrl, windowId: 1 })
    await window.chrome.tabs.create({ active: false, url: duplicateUrl, windowId: 1 })
    const onCreated = Reflect.get(window.chrome.tabs, 'onCreated') as unknown as {
      dispatch: (...args: unknown[]) => void
    }
    onCreated.dispatch()
  })

  await expect(dedupeItem).toHaveText('Dedupe 1 duplicate tab')
  await expect(dedupeItem).toBeEnabled()
  await dedupeItem.click()

  await expect.poll(() => page.evaluate(async () => (
    (await window.chrome.tabs.query({})).filter((tab) => tab.url === 'https://duplicate.example.test/docs').length
  ))).toBe(1)
  await expect(page.getByText('Closed 1 duplicate', { exact: true })).toBeVisible()
  // Inside the popup page the toast viewport uses compact insets instead of
  // the dashboard's page insets: 6px sides (width 288 - 2×6) and an 8px
  // bottom that optically matches the sides under the downward drop shadow.
  const toastViewportGeometry = await page.getByText('Closed 1 duplicate', { exact: true }).evaluate((element) => {
    let node: HTMLElement | null = element instanceof HTMLElement ? element : null
    while (node && getComputedStyle(node).position !== 'fixed') node = node.parentElement
    if (!node) throw new Error('Toast viewport is missing')
    const styles = getComputedStyle(node)
    return { left: styles.left, bottom: styles.bottom, width: styles.width }
  })
  expect(toastViewportGeometry).toEqual({ left: '6px', bottom: '8px', width: '276px' })
  const undoButton = page.getByRole('button', { name: 'Undo' })
  await expect(undoButton).toBeVisible()
  await undoButton.click()

  await expect.poll(() => page.evaluate(async () => (
    (await window.chrome.tabs.query({})).filter((tab) => tab.url === 'https://duplicate.example.test/docs').length
  ))).toBe(2)
  await expect(page.getByText('Restored 1 tab', { exact: true })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('popup close-suspended runs single-flight and reports zero feedback inline', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)
  await enableMergeAvailability(page)

  const suspendedRawUrl = 'chrome-extension://suspender/suspended.html#ttl=Example&uri=https%3A%2F%2Fglobal-close.example.test%2Fdocs'
  await page.evaluate(async (url) => {
    await window.chrome.tabs.create({
      active: false,
      pinned: true,
      url,
      windowId: 1,
    })

    const tabsApi = window.chrome.tabs
    const queryTabs = tabsApi.query.bind(tabsApi)
    const blocked = Promise.withResolvers<void>()
    const gate = {
      queryCount: 0,
      reentered: false,
      release: blocked.resolve,
      started: false,
    }
    Reflect.set(window, '__tabOutCloseSuspendedQueryGate', gate)
    Reflect.set(tabsApi, 'query', async (...args: unknown[]) => {
      gate.queryCount += 1
      if (!gate.started) {
        gate.started = true
        const closeItem = document.querySelector<HTMLElement>('[data-tabout-part="close-suspended-button"]')
        const mergeItem = document.querySelector<HTMLElement>('[data-tabout-part="merge-desktop-windows-button"]')
        if (!closeItem || !mergeItem) throw new Error('Tab action items are unavailable for reentry')
        closeItem.click()
        mergeItem.click()
        gate.reentered = true
      }
      await blocked.promise
      return Reflect.apply(queryTabs, tabsApi, args)
    })
  }, suspendedRawUrl)

  const closeItem = page.locator(CLOSE_SUSPENDED_ITEM)
  await closeItem.click()

  await expect.poll(() => page.evaluate(() => (
    Reflect.get(window, '__tabOutCloseSuspendedQueryGate')?.reentered === true
  ))).toBe(true)
  const dedupeItem = page.locator(DEDUPE_ITEM)
  const combinedItem = page.locator(COMBINED_ITEM)
  const mergeItem = page.locator(MERGE_ITEM)
  await expect(closeItem).toBeDisabled()
  await expect(combinedItem).toBeDisabled()
  await expect(dedupeItem).toBeDisabled()
  await expect(mergeItem).toBeDisabled()
  await expect(mergeItem).toContainText('Another tab action is in progress')
  expect(await page.evaluate(() => (
    Reflect.get(window, '__tabOutCloseSuspendedQueryGate')?.queryCount
  ))).toBe(1)
  expect(await page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string }>)
      .filter((message) => message?.type === 'tab-out:open-desktop-window-merge').length
  ))).toBe(0)

  await page.evaluate(() => {
    const release = Reflect.get(window, '__tabOutCloseSuspendedQueryGate')?.release
    if (typeof release !== 'function') throw new Error('Close-suspended query gate is unavailable')
    Reflect.apply(release, window, [])
  })
  await expect.poll(() => page.evaluate(async (url) => (
    !(await window.chrome.tabs.query({})).some((tab) => tab.url === url)
  ), suspendedRawUrl)).toBe(true)
  await expect(page.getByText('Closed 1 tab', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()

  await expect(closeItem).toBeEnabled()
  await closeItem.click()
  await expect(page.getByText('Nothing suspended to close', { exact: true })).toBeVisible()
})

test('popup profile pairing shares the tab-action single-flight guard', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)
  await page.evaluate(() => {
    Reflect.set(window, '__tabOutPopupMessageHandler', (message: { type?: string } | undefined) => {
      if (message?.type === 'tab-out:select-native-integration-profile') {
        return { ok: true }
      }
      if (message?.type === 'tab-out:get-desktop-window-merge-status') {
        return {
          ok: true,
          availability: { available: false, reason: 'profile-selection-required' },
          session: null,
        }
      }
      return undefined
    })
    const onMessage = Reflect.get(window.chrome.runtime, 'onMessage') as unknown as {
      dispatch: (message: unknown) => void
    }
    onMessage.dispatch({ type: 'tab-out:desktop-window-merge-status-changed' })
  })

  const selectionItem = page.locator(SELECT_NATIVE_PROFILE_ITEM)
  const closeItem = page.locator(CLOSE_SUSPENDED_ITEM)
  await expect(selectionItem).toBeEnabled()

  await page.evaluate(() => {
    const tabsApi = window.chrome.tabs
    const queryTabs = tabsApi.query.bind(tabsApi)
    const blocked = Promise.withResolvers<void>()
    const gate = {
      profileStarted: false,
      queryCount: 0,
      queryCountBeforeProfile: 0,
      releaseProfile: () => {},
      releaseTabAction: blocked.resolve,
      selectionReentered: false,
    }
    Reflect.set(window, '__tabOutProfileSingleFlightGate', gate)
    Reflect.set(tabsApi, 'query', async (...args: unknown[]) => {
      gate.queryCount += 1
      if (gate.queryCount === 1) {
        const profileItem = document.querySelector<HTMLElement>(
          '[data-tabout-part="select-native-profile-button"]',
        )
        if (!profileItem) throw new Error('Profile selection item is unavailable for reentry')
        profileItem.click()
        gate.selectionReentered = true
      }
      await blocked.promise
      return Reflect.apply(queryTabs, tabsApi, args)
    })
    const actionItem = document.querySelector<HTMLElement>(
      '[data-tabout-part="close-suspended-button"]',
    )
    if (!actionItem) throw new Error('Close-suspended item is unavailable')
    actionItem.click()
  })

  await expect.poll(() => page.evaluate(() => (
    Reflect.get(window, '__tabOutProfileSingleFlightGate')?.selectionReentered === true
  ))).toBe(true)
  await expect(selectionItem).toBeDisabled()
  expect(await page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string }>)
      .filter((message) => message?.type === 'tab-out:select-native-integration-profile')
  ))).toEqual([])

  await page.evaluate(() => {
    const release = Reflect.get(window, '__tabOutProfileSingleFlightGate')?.releaseTabAction
    if (typeof release !== 'function') throw new Error('Tab action gate is unavailable')
    Reflect.apply(release, window, [])
  })
  await expect(page.getByText('Nothing suspended to close', { exact: true })).toBeVisible()
  await expect(selectionItem).toBeEnabled()

  await page.evaluate(() => {
    const gate = Reflect.get(window, '__tabOutProfileSingleFlightGate') as {
      profileStarted: boolean
      queryCount: number
      queryCountBeforeProfile: number
      releaseProfile: () => void
    }
    const blocked = Promise.withResolvers<{ ok: true }>()
    let selected = false
    gate.queryCountBeforeProfile = gate.queryCount
    gate.releaseProfile = () => {
      selected = true
      blocked.resolve({ ok: true })
    }
    Reflect.set(window, '__tabOutPopupMessageHandler', (message: { type?: string } | undefined) => {
      if (message?.type === 'tab-out:select-native-integration-profile') {
        gate.profileStarted = true
        const actionItem = document.querySelector<HTMLElement>(
          '[data-tabout-part="close-suspended-button"]',
        )
        if (!actionItem) throw new Error('Close-suspended item is unavailable for reentry')
        actionItem.click()
        return blocked.promise
      }
      if (message?.type === 'tab-out:get-desktop-window-merge-status') {
        return selected
          ? { ok: true, availability: { available: true }, session: null }
          : {
              ok: true,
              availability: { available: false, reason: 'profile-selection-required' },
              session: null,
            }
      }
      return undefined
    })
  })

  await selectionItem.click()
  await expect.poll(() => page.evaluate(() => (
    Reflect.get(window, '__tabOutProfileSingleFlightGate')?.profileStarted === true
  ))).toBe(true)
  await expect(selectionItem).toBeDisabled()
  await expect(closeItem).toBeDisabled()
  expect(await page.evaluate(() => {
    const gate = Reflect.get(window, '__tabOutProfileSingleFlightGate')
    return gate?.queryCount === gate?.queryCountBeforeProfile
  })).toBe(true)

  await page.evaluate(() => {
    const release = Reflect.get(window, '__tabOutProfileSingleFlightGate')?.releaseProfile
    if (typeof release !== 'function') throw new Error('Profile selection gate is unavailable')
    Reflect.apply(release, window, [])
  })
  await expect(selectionItem).not.toBeAttached()
  await expect(page.getByText(
    'This Chrome profile now owns the macOS integration',
    { exact: true },
  )).toBeVisible()
  expect(await page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string }>)
      .filter((message) => message?.type === 'tab-out:select-native-integration-profile')
  ))).toEqual([{ type: 'tab-out:select-native-integration-profile' }])
})

test('popup explicitly pairs the current Chrome profile for the macOS integration', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)
  await page.evaluate(() => {
    let selected = false
    Reflect.set(window, '__tabOutPopupMessageHandler', (message: { type?: string } | undefined) => {
      if (message?.type === 'tab-out:select-native-integration-profile') {
        selected = true
        return { ok: true }
      }
      if (message?.type === 'tab-out:get-desktop-window-merge-status') {
        return selected
          ? { ok: true, availability: { available: true }, session: null }
          : {
              ok: true,
              availability: { available: false, reason: 'profile-selection-required' },
              session: null,
            }
      }
      return undefined
    })
    const onMessage = Reflect.get(window.chrome.runtime, 'onMessage') as unknown as {
      dispatch: (message: unknown) => void
    }
    onMessage.dispatch({ type: 'tab-out:desktop-window-merge-status-changed' })
  })

  const selectionItem = page.locator(SELECT_NATIVE_PROFILE_ITEM)
  await expect(selectionItem).toHaveText('Use this Chrome profile for macOS integration')
  await expect(selectionItem).toBeEnabled()
  await expect(page.locator(MERGE_ITEM)).toContainText(
    'Choose this Chrome profile for the macOS integration',
  )

  await selectionItem.click()

  await expect(selectionItem).not.toBeAttached()
  await expect(page.getByText(
    'This Chrome profile now owns the macOS integration',
    { exact: true },
  )).toBeVisible()
  expect(await page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string }>)
      .filter((message) => message?.type === 'tab-out:select-native-integration-profile')
  ))).toEqual([{ type: 'tab-out:select-native-integration-profile' }])
})

test('popup combines suspended close and dedupe into one Undo', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)

  const suspendedEffectiveUrl = 'https://combined-cleanup.example.test/suspended'
  const suspendedRawUrl = `chrome-extension://suspender/suspended.html#ttl=Example&uri=${encodeURIComponent(suspendedEffectiveUrl)}`
  const duplicateUrl = 'https://combined-cleanup.example.test/duplicate'
  await page.evaluate(async ({ suspendedRawUrl, duplicateUrl }) => {
    await window.chrome.tabs.create({ active: false, url: suspendedRawUrl, windowId: 1 })
    await window.chrome.tabs.create({ active: false, url: duplicateUrl, windowId: 1 })
    await window.chrome.tabs.create({ active: false, url: duplicateUrl, windowId: 1 })
  }, { suspendedRawUrl, duplicateUrl })

  await page.locator(COMBINED_ITEM).click()

  await expect.poll(() => page.evaluate(async ({ suspendedRawUrl, duplicateUrl }) => {
    const tabs = await window.chrome.tabs.query({})
    return {
      duplicateCount: tabs.filter((tab) => tab.url === duplicateUrl).length,
      suspendedCount: tabs.filter((tab) => tab.url === suspendedRawUrl).length,
    }
  }, { suspendedRawUrl, duplicateUrl })).toEqual({
    duplicateCount: 1,
    suspendedCount: 0,
  })
  await expect(page.getByText('Closed 2 tabs', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
})

test('popup moves the invoking window\'s exact active tab into a focused new window', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)

  await page.evaluate(async () => {
    await window.chrome.tabs.create({ active: false, url: 'https://bystander.example.test/', windowId: 1 })
    const windowsApi = window.chrome.windows
    const createWindow = windowsApi.create.bind(windowsApi)
    const created: chrome.windows.CreateData[] = []
    Reflect.set(window, '__tabOutWindowCreates', created)
    Reflect.set(windowsApi, 'create', async (...args: unknown[]) => {
      created.push(args[0] as chrome.windows.CreateData)
      return Reflect.apply(createWindow, windowsApi, args)
    })
  })

  await page.locator(MOVE_CURRENT_TAB_ITEM).click()

  // The fixture's active tab in window 1 is tab id 1; the move must target
  // exactly that physical tab with no URL-opening fallback.
  await expect.poll(() => page.evaluate(() => (
    Reflect.get(window, '__tabOutWindowCreates')
  ))).toEqual([{ tabId: 1, focused: true, type: 'normal' }])
})

test('popup previews the merge, confirms inline, and hands the confirmation off', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)
  await page.evaluate(() => {
    Reflect.set(window, '__tabOutPopupMessageHandler', (message: { type?: string } | undefined) => {
      if (message?.type === 'tab-out:get-desktop-window-merge-status') {
        return { ok: true, availability: { available: true }, session: null }
      }
      if (message?.type === 'tab-out:preview-desktop-window-merge') {
        return {
          ok: true,
          status: 'ready',
          previewId: 'preview-fixture',
          sourceWindowCount: 1,
          movingTabCount: 2,
        }
      }
      return undefined
    })
    const onMessage = Reflect.get(window.chrome.runtime, 'onMessage') as unknown as {
      dispatch: (message: unknown) => void
    }
    onMessage.dispatch({ type: 'tab-out:desktop-window-merge-status-changed' })
  })
  const mergeItem = page.locator(MERGE_ITEM)
  await expect(mergeItem).not.toHaveAttribute('disabled', '')

  await mergeItem.click()
  const confirmView = page.locator('[data-tabout="tab-actions"] [data-tabout-part="merge-confirm"]')
  await expect(confirmView).toBeVisible()
  await expect(confirmView.locator('p')).toHaveText('Move 2 tabs from 1 other window into this window.')
  await expect(confirmView.locator('[data-tabout-part="cancel-button"]')).toBeFocused()
  expect(await page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string, windowId?: number }>)
      .filter((message) => message?.type === 'tab-out:preview-desktop-window-merge')
  ))).toEqual([{ type: 'tab-out:preview-desktop-window-merge', windowId: 1 }])

  await confirmView.locator('[data-tabout-part="cancel-button"]').click()
  await expect(confirmView).not.toBeAttached()
  await expect(mergeItem).toBeVisible()

  await mergeItem.click()
  await expect(confirmView).toBeVisible()
  await confirmView.locator('[data-tabout-part="confirm-button"]').click()

  await expect.poll(() => page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string }>)
      .filter((message) => message?.type === 'tab-out:open-desktop-window-merge')
  ))).toEqual([{
    type: 'tab-out:open-desktop-window-merge',
    windowId: 1,
    previewId: 'preview-fixture',
  }])
})
