import assert from 'node:assert/strict'
import test from 'node:test'

import {
  animateHistoryEntryMoves,
  snapshotHistoryEntryPositions
} from '../src/extension/history-entry-move-animation.js'

function fakeHistoryRow(key: string, top: number) {
  const classes = new Set<string>()
  const state = { top }
  const row = {
    dataset: { taboutLayoutKey: key },
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name))
    },
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 20, top: state.top, width: 260, height: 36 }),
    addEventListener() {},
    removeEventListener() {}
  }
  return {
    classes,
    moveTo(nextTop: number) {
      state.top = nextTop
    },
    row: row as unknown as HTMLElement,
    style: row.style
  }
}

test('Activation History survivors move into the removed row position with FLIP', () => {
  const removed = fakeHistoryRow('removed', 20)
  const survivor = fakeHistoryRow('survivor', 58)
  const rows = [removed, survivor]
  const root = {
    querySelectorAll: () => rows
      .filter((candidate) => !candidate.classes.has('closing'))
      .map((candidate) => candidate.row),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 500 })
  } as unknown as HTMLElement

  const previous = snapshotHistoryEntryPositions(root)
  removed.classes.add('closing')
  survivor.moveTo(20)
  animateHistoryEntryMoves(root, previous)

  assert.equal(survivor.style.transform, 'translate(0px, 38px)')
})
