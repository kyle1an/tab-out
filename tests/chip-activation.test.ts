import assert from 'node:assert/strict'
import test from 'node:test'

import { chipActivationMode } from '../src/components/chip-activation.js'

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

test('chipActivationMode: Cmd-click opens a background tab on macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true }, MAC), 'new-background')
})

test('chipActivationMode: Cmd+Shift-click opens a foreground tab on macOS', () => {
  assert.equal(chipActivationMode({ metaKey: true, shiftKey: true }, MAC), 'new-foreground')
})

test('chipActivationMode: Ctrl is not the primary modifier on macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, MAC), 'focus')
})

test('chipActivationMode: Ctrl-click opens a background tab off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true }, WIN), 'new-background')
})

test('chipActivationMode: Ctrl+Shift-click opens a foreground tab off macOS', () => {
  assert.equal(chipActivationMode({ ctrlKey: true, shiftKey: true }, WIN), 'new-foreground')
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
