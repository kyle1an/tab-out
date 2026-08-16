import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'

import { createUrlPreviewController, URL_PREVIEW_HIDE_DELAY_MS } from '../../src/hooks/useUrlPreview.js'
import { createHoverStateStore } from '../../src/lib/hover-state.js'

afterEach(() => vi.useRealTimers())

it('hover store notifies only old and new matches across hundreds of leaf selectors', () => {
  const store = createHoverStateStore()
  const urls = Array.from({ length: 500 }, (_, index) => `https://example.test/page-${index}`)
  const notifications = Array.from({ length: urls.length }, () => 0)
  const unsubscribe = urls.map((url, index) => store.subscribeSelector(
    (state) => state.source !== 'chip' && state.urls.includes(url),
    () => {
      const count = notifications[index]
      assert.ok(count !== undefined)
      notifications[index] = count + 1
    },
  ))
  const urlAt = (index: number): string => {
    const url = urls[index]
    assert.ok(url)
    return url
  }

  store.setSnapshot({
    url: urlAt(173),
    urls: [urlAt(173)],
    source: 'history',
  })
  assert.equal(notifications.reduce((total, count) => total + count, 0), 1)
  assert.equal(notifications[173], 1)

  store.setSnapshot({
    url: urlAt(318),
    urls: [urlAt(318)],
    source: 'history',
  })
  assert.equal(notifications.reduce((total, count) => total + count, 0), 3)
  assert.equal(notifications[173], 2)
  assert.equal(notifications[318], 1)
  assert.equal(notifications.filter(Boolean).length, 2)

  // A source-only update with the same selected result does not schedule any
  // leaf update, and a semantically identical snapshot is ignored entirely.
  store.setSnapshot({ url: urlAt(318), urls: [urlAt(318)], source: 'working-set' })
  store.setSnapshot({ url: urlAt(318), urls: [urlAt(318)], source: 'working-set' })
  assert.equal(notifications.reduce((total, count) => total + count, 0), 3)

  // Page Chips do not cross-highlight other Page Chips, so only the previous
  // matching leaf is notified when the source changes to chip.
  store.setSnapshot({ url: urlAt(318), urls: [urlAt(318)], source: 'chip' })
  assert.equal(notifications.reduce((total, count) => total + count, 0), 4)
  assert.equal(notifications[318], 2)

  for (const stop of unsubscribe) stop()
  store.setSnapshot({ url: urlAt(99), urls: [urlAt(99)], source: 'history' })
  assert.equal(notifications.reduce((total, count) => total + count, 0), 4)
})

it('url preview updates independently and preserves the delayed hide contract', () => {
  vi.useFakeTimers()
  const controller = createUrlPreviewController()
  let notifications = 0
  const unsubscribe = controller.store.subscribe(() => { notifications += 1 })

  try {
    controller.setUrlPreview('https://example.test/first')
    assert.deepEqual(controller.store.getSnapshot(), {
      url: 'https://example.test/first',
      visible: true,
    })
    assert.equal(notifications, 1)

    controller.setUrlPreview('')
    vi.advanceTimersByTime(URL_PREVIEW_HIDE_DELAY_MS - 1)
    assert.equal(controller.store.getSnapshot().visible, true)
    assert.equal(notifications, 1)

    controller.setUrlPreview('https://example.test/second')
    vi.advanceTimersByTime(URL_PREVIEW_HIDE_DELAY_MS)
    assert.deepEqual(controller.store.getSnapshot(), {
      url: 'https://example.test/second',
      visible: true,
    })
    assert.equal(notifications, 2)

    controller.setUrlPreview('')
    vi.advanceTimersByTime(URL_PREVIEW_HIDE_DELAY_MS)
    assert.deepEqual(controller.store.getSnapshot(), {
      url: 'https://example.test/second',
      visible: false,
    })
    assert.equal(notifications, 3)

    controller.clearUrlPreviewNow()
    assert.deepEqual(controller.store.getSnapshot(), { url: '', visible: false })
    assert.equal(notifications, 4)
  } finally {
    unsubscribe()
    controller.dispose()
  }
})
