import assert from 'node:assert/strict'
import test from 'node:test'

import { truncatedTitleFadeEndPx } from '../src/components/title-expansion/index.js'

// Geometry captured from the dashboard fixture: a 174px-wide history title
// clamped to two 16.25px lines (clientHeight 33), where hyphenation ends the
// second line 39.5px short of the box edge and the remainder of the token
// sits on a third line hidden below the clip.
const BOX = { left: 75, top: 62, width: 174, clipHeight: 33 }
const LINE_HEIGHT = 16.25

function fragment(top: number, right: number, width = 40) {
  return { top, right, width, height: 15 }
}

test('truncatedTitleFadeEndPx anchors the fade to the last visible line end', () => {
  const fragments = [
    fragment(BOX.top, 244),
    fragment(BOX.top + LINE_HEIGHT, 209.5),
    fragment(BOX.top + LINE_HEIGHT * 2, 233.3),
  ]
  assert.equal(truncatedTitleFadeEndPx(fragments, BOX), 134.5)
})

test('truncatedTitleFadeEndPx groups same-line fragments despite sub-pixel top jitter', () => {
  const fragments = [
    fragment(BOX.top, 200),
    fragment(BOX.top + LINE_HEIGHT, 150),
    fragment(BOX.top + LINE_HEIGHT - 1, 180),
    fragment(BOX.top + LINE_HEIGHT + 1, 165),
  ]
  assert.equal(truncatedTitleFadeEndPx(fragments, BOX), 180 - BOX.left)
})

test('truncatedTitleFadeEndPx ignores zero-size fragments', () => {
  const fragments = [
    fragment(BOX.top, 244),
    { top: BOX.top + LINE_HEIGHT, right: 246, width: 0, height: 0 },
    fragment(BOX.top + LINE_HEIGHT, 209.5),
  ]
  assert.equal(truncatedTitleFadeEndPx(fragments, BOX), 134.5)
})

test('truncatedTitleFadeEndPx keeps at least one fade ramp of text solid', () => {
  const fragments = [
    fragment(BOX.top, 244),
    fragment(BOX.top + LINE_HEIGHT, BOX.left + 30, 30),
  ]
  assert.equal(truncatedTitleFadeEndPx(fragments, BOX), 60)
})

test('truncatedTitleFadeEndPx never reaches past the element edge', () => {
  const fragments = [fragment(BOX.top, BOX.left + BOX.width + 24)]
  assert.equal(truncatedTitleFadeEndPx(fragments, BOX), BOX.width)
})

test('truncatedTitleFadeEndPx returns null without visible fragments', () => {
  assert.equal(truncatedTitleFadeEndPx([], BOX), null)
  const hiddenLine = [fragment(BOX.top + LINE_HEIGHT * 2, 233.3)]
  assert.equal(truncatedTitleFadeEndPx(hiddenLine, BOX), null)
})
