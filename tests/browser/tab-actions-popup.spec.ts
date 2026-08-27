import { expect, test, type Page } from '@playwright/test'

const POPUP_FIXTURE = '/tests/fixtures/tab-actions-popup.html'

const DEDUPE_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="dedupe-button"]'
const CLOSE_SUSPENDED_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="close-suspended-button"]'
const COMBINED_ITEM = '[data-tabout="tab-actions"] [data-tabout-part="close-suspended-and-dedupe-button"]'
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
  await expect(mergeItem).toContainText('Merge windows on this desktop…')
  await expect(mergeItem).toBeDisabled()
  await expect(mergeItem).toContainText('Window merge coordination is unavailable in this Chrome session')
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

test('popup merge item hands the preview off to the invoking window', async ({ page }) => {
  await page.goto(POPUP_FIXTURE)
  await enableMergeAvailability(page)

  await page.locator(MERGE_ITEM).click()

  await expect.poll(() => page.evaluate(() => (
    (Reflect.get(window, '__tabOutPopupSentMessages') as Array<{ type?: string, windowId?: number }>)
      .filter((message) => message?.type === 'tab-out:open-desktop-window-merge')
  ))).toEqual([{ type: 'tab-out:open-desktop-window-merge', windowId: 1 }])
})
