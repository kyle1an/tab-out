import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopWindowMergeConfirmMessage,
  parseDesktopWindowMergeJournal,
  parseDesktopWindowMergeStatusResponse,
} from '../src/extension/desktop-window-merge-contract.js'

function journal(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionId: 'session-example',
    status: 'running',
    ownerTabId: 1,
    destinationWindowId: 10,
    sourceWindowCount: 2,
    plannedTabCount: 4,
    movedTabCount: 1,
    remainingTabCount: 3,
    startedAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_100,
    ...overrides,
  }
}

test('desktop merge messages accept only bounded opaque identifiers', () => {
  assert.deepEqual(parseDesktopWindowMergeConfirmMessage({
    type: 'tab-out:confirm-desktop-window-merge',
    previewId: 'preview-example',
  }), {
    type: 'tab-out:confirm-desktop-window-merge',
    previewId: 'preview-example',
  })
  assert.equal(parseDesktopWindowMergeConfirmMessage({
    type: 'tab-out:confirm-desktop-window-merge',
    previewId: 'contains spaces',
  }), null)
})

test('desktop merge journals reject inconsistent or misleading terminal state', () => {
  assert.deepEqual(parseDesktopWindowMergeJournal(journal()), journal())
  assert.equal(parseDesktopWindowMergeJournal(journal({ remainingTabCount: 2 })), null)
  assert.equal(parseDesktopWindowMergeJournal(journal({
    status: 'succeeded',
    movedTabCount: 3,
    remainingTabCount: 1,
  })), null)
  assert.equal(parseDesktopWindowMergeJournal(journal({
    status: 'interrupted',
    errorCode: 'browser-mutation-failed',
  })), null)
})

test('desktop merge status responses cannot smuggle an invalid journal to the page', () => {
  assert.equal(parseDesktopWindowMergeStatusResponse({
    ok: true,
    availability: { available: true },
    session: {
      isOwner: true,
      journal: journal({
        status: 'succeeded',
        movedTabCount: 3,
        remainingTabCount: 1,
      }),
    },
  }), null)
})
