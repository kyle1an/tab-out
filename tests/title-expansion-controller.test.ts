import assert from 'node:assert/strict'
import test from 'node:test'

import { createTitleExpansionController, createTitleExpansionLane } from '../src/components/title-expansion/index.js'
import type { TitleExpansionScheduler } from '../src/components/title-expansion/index.js'

type ScheduledTask = { fn: () => void, delayMs: number, cleared: boolean }

function createFakeScheduler() {
  const tasks: ScheduledTask[] = []
  const scheduler: TitleExpansionScheduler = {
    set(fn, delayMs) {
      const task: ScheduledTask = { fn, delayMs, cleared: false }
      tasks.push(task)
      return task
    },
    clear(handle) {
      const task = tasks.find((candidate) => candidate === handle)
      if (task) task.cleared = true
    },
  }
  function firePending() {
    for (const task of tasks.splice(0)) {
      if (!task.cleared) task.fn()
    }
  }
  function pendingCount() {
    return tasks.filter((task) => !task.cleared).length
  }
  return { scheduler, tasks, firePending, pendingCount }
}

function createRecordingController(lane = createTitleExpansionLane(), overrides: Record<string, unknown> = {}) {
  const fake = createFakeScheduler()
  const expandedChanges: boolean[] = []
  const controller = createTitleExpansionController({
    id: 'entry-a',
    lane,
    closeDelayMs: 160,
    scheduler: fake.scheduler,
    onExpandedChange: (expanded: boolean) => expandedChanges.push(expanded),
    ...overrides,
  })
  return { controller, lane, fake, expandedChanges }
}

test('lane activation notifies subscribers once per change and skips same-id re-activation', () => {
  const lane = createTitleExpansionLane()
  const seen: (string | null)[] = []
  const unsubscribe = lane.subscribe((activeId) => seen.push(activeId))

  lane.activate('one')
  lane.activate('one')
  lane.activate('two')
  lane.release('one')
  lane.release('two')

  assert.deepEqual(seen, ['one', 'two', null])
  assert.equal(lane.getActiveId(), null)

  unsubscribe()
  lane.activate('three')
  assert.deepEqual(seen, ['one', 'two', null])
})

test('lane release is owner-guarded so a stale owner cannot clear a newer one', () => {
  const lane = createTitleExpansionLane()
  lane.activate('one')
  lane.activate('two')
  lane.release('one')
  assert.equal(lane.getActiveId(), 'two')
})

test('open activates the lane and reports expansion once', () => {
  const { controller, lane, expandedChanges } = createRecordingController()

  controller.open()
  controller.open()

  assert.equal(lane.getActiveId(), 'entry-a')
  assert.equal(controller.isExpanded(), true)
  assert.deepEqual(expandedChanges, [true])
})

test('delayed close waits for the configured delay before collapsing and releasing the lane', () => {
  const { controller, lane, fake, expandedChanges } = createRecordingController()

  controller.open()
  controller.close()

  assert.equal(fake.tasks[0]?.delayMs, 160)
  assert.equal(controller.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-a')

  fake.firePending()

  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
  assert.deepEqual(expandedChanges, [true, false])
})

test('immediate close collapses and releases without scheduling', () => {
  const { controller, lane, fake, expandedChanges } = createRecordingController()

  controller.open()
  controller.close({ delayed: false })

  assert.equal(fake.pendingCount(), 0)
  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
  assert.deepEqual(expandedChanges, [true, false])
})

test('re-opening before a delayed close fires cancels the pending collapse', () => {
  const { controller, lane, fake, expandedChanges } = createRecordingController()

  controller.open()
  controller.close()
  controller.open()
  fake.firePending()

  assert.equal(controller.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-a')
  assert.deepEqual(expandedChanges, [true])
})

test('cancelPendingClose keeps the expansion open through the scheduled fire', () => {
  const { controller, fake, expandedChanges } = createRecordingController()

  controller.open()
  controller.close()
  controller.cancelPendingClose()
  fake.firePending()

  assert.equal(controller.isExpanded(), true)
  assert.deepEqual(expandedChanges, [true])
})

test('shouldCancelClose vetoes close at entry and clears any pending collapse', () => {
  let menuOpen = false
  const { controller, fake, expandedChanges } = createRecordingController(createTitleExpansionLane(), {
    shouldCancelClose: () => menuOpen,
  })

  controller.open()
  controller.close()
  menuOpen = true
  controller.close()

  assert.equal(fake.pendingCount(), 0)
  fake.firePending()
  assert.equal(controller.isExpanded(), true)
  assert.deepEqual(expandedChanges, [true])
})

test('shouldCancelClose is re-checked when the delayed close fires', () => {
  let menuOpen = false
  const { controller, lane, fake } = createRecordingController(createTitleExpansionLane(), {
    shouldCancelClose: () => menuOpen,
  })

  controller.open()
  controller.close()
  menuOpen = true
  fake.firePending()

  assert.equal(controller.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-a')
})

test('closeNow collapses and releases even while shouldCancelClose vetoes', () => {
  const { controller, lane } = createRecordingController(createTitleExpansionLane(), {
    shouldCancelClose: () => true,
  })

  controller.open()
  controller.closeNow()

  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
})

test('a lane steal collapses the previous owner without touching the new owner', () => {
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane)
  const fakeB = createFakeScheduler()
  const second = createTitleExpansionController({
    id: 'entry-b',
    lane,
    closeDelayMs: 160,
    scheduler: fakeB.scheduler,
    onExpandedChange: () => {},
  })

  first.controller.open()
  second.open()

  assert.equal(first.controller.isExpanded(), false)
  assert.equal(second.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-b')
  assert.deepEqual(first.expandedChanges, [true, false])
})

test('shouldIgnoreLaneSteal keeps the previous owner expanded while the lane moves on', () => {
  let menuOpen = true
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane, {
    shouldIgnoreLaneSteal: () => menuOpen,
  })

  first.controller.open()
  lane.activate('entry-b')

  assert.equal(first.controller.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-b')

  menuOpen = false
  lane.activate('entry-c')
  assert.equal(first.controller.isExpanded(), false)
})

test('a delayed close that fires after a steal collapses the entry but leaves the lane with its new owner', () => {
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane, {
    shouldIgnoreLaneSteal: () => true,
  })

  first.controller.open()
  first.controller.close()
  lane.activate('entry-b')
  first.fake.firePending()

  assert.equal(first.controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), 'entry-b')
})

test('dispose clears pending closes, releases an owned lane, and stops reacting to the lane', () => {
  const lane = createTitleExpansionLane()
  const { controller, fake, expandedChanges } = createRecordingController(lane)

  controller.open()
  controller.close()
  controller.dispose()

  assert.equal(lane.getActiveId(), null)
  fake.firePending()
  lane.activate('entry-b')
  assert.deepEqual(expandedChanges, [true])
})

test('dispose does not release a lane owned by someone else', () => {
  const lane = createTitleExpansionLane()
  const { controller } = createRecordingController(lane)

  controller.open()
  lane.activate('entry-b')
  controller.dispose()

  assert.equal(lane.getActiveId(), 'entry-b')
})
