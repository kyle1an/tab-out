import assert from 'node:assert/strict'
import test from 'node:test'

import {
  animateIntraCardMoves,
  prepareIntraCardMoveAnimation
} from '../src/extension/intra-card-move-animation.js'

type Rect = { left: number; top: number; width?: number; height?: number }

function fakeLayoutElement(key: string, scope: string, rect: Rect) {
  const classes = new Set<string>()
  const state = { rect }
  const element = {
    dataset: {
      taboutLayoutKey: key,
      taboutLayoutScope: scope
    },
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name))
    },
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({
      left: state.rect.left,
      top: state.rect.top,
      width: state.rect.width ?? 120,
      height: state.rect.height ?? 36
    }),
    addEventListener() {},
    removeEventListener() {}
  }
  return {
    classes,
    element: element as unknown as HTMLElement,
    moveTo(next: Rect) {
      state.rect = next
    },
    style: element.style
  }
}

test('intra-card move animation keeps a pinned item and its siblings visually continuous', () => {
  const scope = 'page-chip:scope-alpha'
  const target = fakeLayoutElement('page-alpha', scope, { left: 24, top: 120 })
  const sibling = fakeLayoutElement('page-beta', scope, { left: 24, top: 80 })
  const unrelated = fakeLayoutElement('page-gamma', 'page-chip:scope-beta', { left: 24, top: 40 })
  const items = [target, sibling, unrelated]
  const root = {
    querySelectorAll: () => items.map((item) => item.element),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 500 })
  } as unknown as HTMLElement
  ;(target.element as unknown as { closest: () => HTMLElement }).closest = () => root

  const prepared = prepareIntraCardMoveAnimation(target.element)
  target.moveTo({ left: 24, top: 80 })
  sibling.moveTo({ left: 24, top: 120 })
  animateIntraCardMoves(prepared)

  assert.equal(target.style.transform, 'translate(0px, 40px)')
  assert.equal(sibling.style.transform, 'translate(0px, -40px)')
  assert.equal(unrelated.style.transform ?? '', '')
})

test('intra-card move animation can use a nested variant as the anchor for a recreated Page Chip', () => {
  const scope = 'page-chip:scope-alpha'
  const variantAnchor = fakeLayoutElement('page-alpha', scope, { left: 80, top: 140, width: 90, height: 22 })
  const recreatedChip = fakeLayoutElement('page-alpha', scope, { left: 24, top: 80, width: 260, height: 36 })
  let snapshotPhase = true
  const root = {
    querySelectorAll: (selector: string) => {
      if (selector.includes('layout-anchor')) return snapshotPhase ? [variantAnchor.element] : []
      return snapshotPhase ? [] : [recreatedChip.element]
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 500 })
  } as unknown as HTMLElement
  ;(variantAnchor.element as unknown as { closest: () => HTMLElement }).closest = () => root

  const prepared = prepareIntraCardMoveAnimation(variantAnchor.element)
  snapshotPhase = false
  animateIntraCardMoves(prepared)

  assert.equal(recreatedChip.style.transform, 'translate(56px, 60px)')
})

test('reduced-motion pinning settles the destination with opacity only', () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) }
  })

  try {
    const scope = 'page-chip:scope-alpha'
    const target = fakeLayoutElement('page-alpha', scope, { left: 24, top: 120 })
    const animations: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = []
    ;(target.element as unknown as {
      animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => void
    }).animate = (frames, options) => {
      animations.push({ frames, options })
    }
    const root = {
      querySelectorAll: () => [target.element],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 500 })
    } as unknown as HTMLElement
    ;(target.element as unknown as { closest: () => HTMLElement }).closest = () => root

    const prepared = prepareIntraCardMoveAnimation(target.element, { reducedMotionOpacity: true })
    target.moveTo({ left: 24, top: 80 })
    animateIntraCardMoves(prepared)

    assert.deepEqual(animations, [{
      frames: [{ opacity: 0.9 }, { opacity: 1 }],
      options: { duration: 120, easing: 'linear' }
    }])
    assert.equal(target.style.transform ?? '', '')
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow
    })
  }
})
