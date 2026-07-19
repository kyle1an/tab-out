import assert from 'node:assert/strict'
import test from 'node:test'

import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import {
  chipActivationMode,
  performDashboardItemActivation,
  shouldSuppressSelectionForGesture
} from '../src/extension/tab-activation.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

const MAC = 'MacIntel'
const WIN = 'Win32'

test('chipActivationMode returns focus when there is no event', () => {
  assert.equal(chipActivationMode(undefined, MAC), 'focus')
  assert.equal(chipActivationMode(null, MAC), 'focus')
})

test('chipActivationMode treats a plain click as focus on every platform', () => {
  assert.equal(chipActivationMode({}, MAC), 'focus')
  assert.equal(chipActivationMode({}, WIN), 'focus')
})

test('chipActivationMode: Cmd-click brings the tab into the current window (background) on macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, MAC), 'bring-background')
})

test('chipActivationMode: Shift-click uses the new-window mode on every platform', () => {
  assert.equal(chipActivationMode({ shiftKey: true }, MAC), 'open-window')
  assert.equal(chipActivationMode({ shiftKey: true }, WIN), 'open-window')
})

test('chipActivationMode: Ctrl is not the primary modifier on macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, MAC), 'focus')
})

test('chipActivationMode: Ctrl-click brings the tab into the current window (background) off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, WIN), 'bring-background')
})

test('chipActivationMode: primary modifier plus Shift brings the tab in and switches (foreground)', () => {
  assert.equal(chipActivationMode({ metaKey: true, shiftKey: true }, MAC), 'bring-foreground')
  assert.equal(chipActivationMode({ ctrlKey: true, shiftKey: true }, WIN), 'bring-foreground')
})

test('chipActivationMode: Cmd is not the primary modifier off macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, WIN), 'focus')
})

test('chipActivationMode: holding both Cmd and Ctrl is ambiguous and stays focus', () => {
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, WIN), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true, shiftKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true, shiftKey: true }, WIN), 'focus')
})

test('shouldSuppressSelectionForGesture: a plain click keeps selection (so drag-select still works)', () => {
  assert.equal(shouldSuppressSelectionForGesture(undefined, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture(null, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, WIN), false)
})

test('shouldSuppressSelectionForGesture: special gestures suppress native selection on macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, MAC), true)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true, shiftKey: true }, MAC), true)
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, MAC), true)
})

test('shouldSuppressSelectionForGesture: special gestures suppress native selection off macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, WIN), true)
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true, shiftKey: true }, WIN), true)
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, WIN), true)
})

test('shouldSuppressSelectionForGesture: a wrong-platform primary modifier keeps selection', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, WIN), false)
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true, shiftKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true, shiftKey: true }, WIN), false)
})

test('modifier activation opens a missing target with the requested current-window focus state', async (t) => {
  const tabs: chrome.tabs.Tab[] = []
  setChromeTabsApi(createFakeChromeApi({ tabs }))
  t.after(() => setChromeTabsApi(null))

  const handled = await performDashboardItemActivation('bring-background', {
    tabUrl: 'https://example.test/docs'
  })

  assert.equal(handled, true)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0]?.url, 'https://example.test/docs')
  assert.equal(tabs[0]?.active, false)
})
