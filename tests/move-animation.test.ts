import assert from 'node:assert/strict'
import test from 'node:test'

import { createMoveAnimator } from '../src/extension/move-animation.js'
import type { MoveAnimatorConfig, MovePositionMap } from '../src/extension/move-animation.js'

type Rect = { left: number; top: number; width?: number; height?: number }

function fakeItem(key: string, rect: Rect) {
  const classes = new Set<string>()
  const listeners: Array<(e: unknown) => void> = []
  const state = { rect }
  const el = {
    dataset: { key },
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name)
    },
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: state.rect.left, top: state.rect.top, width: state.rect.width ?? 100, height: state.rect.height ?? 40 }),
    addEventListener: (_type: string, handler: (e: unknown) => void) => {
      listeners.push(handler)
    },
    removeEventListener: (_type: string, handler: (e: unknown) => void) => {
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
    },
    matches: () => true
  }
  return {
    el: el as unknown as HTMLElement,
    classes,
    listeners,
    style: el.style,
    moveTo(next: Rect) {
      state.rect = next
    }
  }
}

type Fake = ReturnType<typeof fakeItem>

function fakeRoot(items: Fake[], origin: { left: number; top: number } = { left: 0, top: 0 }) {
  return {
    querySelectorAll: () => items.map((item) => item.el),
    getBoundingClientRect: () => ({ left: origin.left, top: origin.top, width: 800, height: 600 })
  } as unknown as HTMLElement
}

function makeConfig(overrides: Partial<MoveAnimatorConfig> = {}): MoveAnimatorConfig {
  return {
    itemSelector: '.item',
    keyOf: (el) => (el as unknown as { dataset: { key?: string } }).dataset.key || '',
    duration: 30,
    movingClass: 'moving',
    activeClass: 'moving-active',
    coordinateSpace: 'viewport',
    ...overrides
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('move animation inverts, plays on the motion token, and cleans up by timeout', async () => {
  const cleaned: string[] = []
  const item = fakeItem('a', { left: 100, top: 100 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig({ afterCleanup: () => cleaned.push('a') }))

  const previous = animator.snapshot([root])
  item.moveTo({ left: 200, top: 150 })
  animator.animate([root], previous)

  assert.equal(item.style.transform, 'translate(-100px, -50px)')
  assert.equal(item.style.transition, 'none')
  assert.equal(item.classes.has('moving'), true)
  assert.equal(item.style.willChange, 'transform')

  await sleep(25)
  assert.equal(item.style.transform, 'translate(0, 0)')
  assert.equal(item.style.transition, 'transform 30ms var(--ease-swift)')
  assert.equal(item.classes.has('moving-active'), true)

  await sleep(120)
  assert.deepEqual(cleaned, ['a'])
  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform, '')
  assert.equal(item.style.transition, '')
  assert.equal(item.style.willChange, '')
})

test('sub-pixel moves are skipped entirely', () => {
  const item = fakeItem('a', { left: 100, top: 100 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  item.moveTo({ left: 100.4, top: 100.4 })
  animator.animate([root], previous)

  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform ?? '', '')
})

test('duplicate keys resolve by closest previous position', () => {
  const first = fakeItem('dup', { left: 0, top: 0 })
  const second = fakeItem('dup', { left: 500, top: 0 })
  const root = fakeRoot([first, second])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  first.moveTo({ left: 490, top: 0 })
  second.moveTo({ left: 10, top: 0 })
  animator.animate([root], previous)

  assert.equal(first.style.transform, 'translate(10px, 0px)')
  assert.equal(second.style.transform, 'translate(-10px, 0px)')
})

test('cancel clears a mid-flight move, fires onCancel, and suppresses cleanup hooks', async () => {
  const events: string[] = []
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(
    makeConfig({
      afterCleanup: () => events.push('cleanup'),
      onCancel: () => events.push('cancel')
    })
  )

  const previous = animator.snapshot([root])
  item.moveTo({ left: 300, top: 0 })
  animator.animate([root], previous)
  assert.equal(item.classes.has('moving'), true)

  animator.cancel([root])
  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform, '')
  assert.ok(events.includes('cancel'))

  await sleep(150)
  assert.equal(events.includes('cleanup'), false)
})

test('transitionend on transform cleans up before the fallback timeout', async () => {
  const cleaned: string[] = []
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig({ duration: 5000, afterCleanup: () => cleaned.push('a') }))

  const previous = animator.snapshot([root])
  item.moveTo({ left: 300, top: 0 })
  animator.animate([root], previous)

  await sleep(25)
  assert.equal(item.classes.has('moving-active'), true)
  item.listeners.slice().forEach((handler) => handler({ target: item.el, propertyName: 'transform' }))

  assert.deepEqual(cleaned, ['a'])
  assert.equal(item.classes.size, 0)
})

test('beforePlay fires only when movers exist and can be suppressed per call', () => {
  const calls: string[] = []
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig({ beforePlay: () => calls.push('config') }))

  animator.animate([root], animator.snapshot([root]))
  assert.deepEqual(calls, [])

  const previous = animator.snapshot([root])
  item.moveTo({ left: 40, top: 0 })
  animator.animate([root], previous, { beforePlay: null })
  assert.deepEqual(calls, [])
  animator.cancel([root])

  const again = animator.snapshot([root])
  item.moveTo({ left: 80, top: 0 })
  animator.animate([root], again)
  assert.deepEqual(calls, ['config'])
  animator.cancel([root])
})

test('root coordinate space measures grid-local positions', () => {
  const item = fakeItem('a', { left: 312, top: 234 })
  const root = fakeRoot([item], { left: 300, top: 200 })
  const animator = createMoveAnimator(makeConfig({ coordinateSpace: 'root' }))

  const positions = animator.snapshot([root])
  assert.deepEqual(positions.get('a'), [{ left: 12, top: 34, width: 100, height: 40 }])
})

test('reduced motion disables snapshot and animate', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: true }) }
  try {
    const item = fakeItem('a', { left: 0, top: 0 })
    const root = fakeRoot([item])
    const animator = createMoveAnimator(makeConfig())

    assert.equal(animator.snapshot([root]).size, 0)

    const previous: MovePositionMap = new Map([['a', [{ left: 500, top: 0, width: 100, height: 40 }]]])
    animator.animate([root], previous)
    assert.equal(item.classes.size, 0)
  } finally {
    if (previousWindow !== undefined) (globalThis as { window?: unknown }).window = previousWindow
    else delete (globalThis as { window?: unknown }).window
  }
})
