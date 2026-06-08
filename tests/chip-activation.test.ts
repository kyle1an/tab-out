import assert from 'node:assert/strict'
import test from 'node:test'

import { chipActivationMode, shouldSuppressSelectionForGesture } from '../src/components/chip-activation.js'

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

test('chipActivationMode: Cmd+Shift-click brings the tab in and switches (foreground) on macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true, shiftKey: true }, MAC), 'bring-foreground')
})

test('chipActivationMode: Ctrl is not the primary modifier on macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, MAC), 'focus')
})

test('chipActivationMode: Ctrl-click brings the tab into the current window (background) off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, WIN), 'bring-background')
})

test('chipActivationMode: Ctrl+Shift-click brings the tab in and switches (foreground) off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true, shiftKey: true }, WIN), 'bring-foreground')
})

test('chipActivationMode: Cmd is not the primary modifier off macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, WIN), 'focus')
})

test('chipActivationMode: Shift alone stays focus (new-window gesture is out of scope)', () => {
  assert.equal(chipActivationMode({ shiftKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ shiftKey: true }, WIN), 'focus')
})

test('chipActivationMode: holding both Cmd and Ctrl is ambiguous and stays focus', () => {
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, MAC), 'focus')
  assert.equal(chipActivationMode({ metaKey: true, ctrlKey: true }, WIN), 'focus')
})

test('shouldSuppressSelectionForGesture: a plain click keeps selection (so drag-select still works)', () => {
  assert.equal(shouldSuppressSelectionForGesture(undefined, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture(null, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({}, WIN), false)
})

test('shouldSuppressSelectionForGesture: the move gestures suppress native selection on macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, MAC), true)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true, shiftKey: true }, MAC), true)
})

test('shouldSuppressSelectionForGesture: the move gestures suppress native selection off macOS', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, WIN), true)
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true, shiftKey: true }, WIN), true)
})

test('shouldSuppressSelectionForGesture: Shift alone keeps selection (not a move gesture)', () => {
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ shiftKey: true }, WIN), false)
})

test('shouldSuppressSelectionForGesture: a wrong-platform primary modifier keeps selection', () => {
  assert.equal(shouldSuppressSelectionForGesture({ ctrlKey: true }, MAC), false)
  assert.equal(shouldSuppressSelectionForGesture({ metaKey: true }, WIN), false)
})
