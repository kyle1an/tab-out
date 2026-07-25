import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LAYOUT_REMOVAL_ANIMATION_MS,
  REDUCED_LAYOUT_REMOVAL_ANIMATION_MS,
  startLayoutRemovalAnimation
} from '../src/components/LayoutRemovalAnimation.js'

type RemovalGhost = {
  ariaHidden?: string
  inert?: string
  classList: {
    classes: string[]
    add: (...names: string[]) => void
  }
  removed?: boolean
  style: Record<string, string>
  getBoundingClientRect: () => void
  setAttribute: (name: string, value: string) => void
  remove: () => void
}

function fakeRemovalSurface() {
  const classes = new Set<string>()
  const layoutAttributes = new Map<string, string>()
  const visualAttributes = new Map<string, string>()
  const appendedNodes: RemovalGhost[] = []
  const visualStyle: Record<string, string> = {}
  const layoutStyle: Record<string, string> = {}
  const layoutElement = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name))
    },
    isConnected: true,
    setAttribute(name: string, value: string) {
      layoutAttributes.set(name, value)
    },
    style: layoutStyle
  }
  const visualElement = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name))
    },
    setAttribute(name: string, value: string) {
      visualAttributes.set(name, value)
    },
    style: visualStyle,
    ownerDocument: {
      body: {
        appendChild(node: (typeof appendedNodes)[number]) {
          appendedNodes.push(node)
        }
      }
    },
    cloneNode: (): RemovalGhost => {
      const ghost: RemovalGhost = {
        classList: {
          classes: [],
          add(...names: string[]) {
            ghost.classList.classes.push(...names)
          }
        },
        style: {},
        getBoundingClientRect() {},
        setAttribute(name: string, value: string) {
          if (name === 'aria-hidden') ghost.ariaHidden = value
          if (name === 'inert') ghost.inert = value
        },
        remove() {
          ghost.removed = true
        }
      }
      return ghost
    },
    getBoundingClientRect: () => ({ left: 12, top: 24, width: 240, height: 36 })
  }

  return {
    appendedNodes,
    classes,
    layoutAttributes,
    layoutElement,
    layoutStyle,
    visualAttributes,
    visualElement,
    visualStyle
  }
}

test('layout removal leaves a transform-only exit ghost and removes the real row from flow', () => {
  const surface = fakeRemovalSurface()
  const events: string[] = []
  let cleanupDelay = 0

  const started = startLayoutRemovalAnimation(surface.visualElement, {
    ghostClassName: 'example-closing-ghost',
    layoutElement: surface.layoutElement,
    onBeforeRemove: () => events.push('before'),
    onAfterRemove: () => events.push('after'),
    scheduleCleanup: (handler, delay) => {
      cleanupDelay = delay
      handler()
      return 1
    }
  })

  assert.equal(started, true)
  assert.deepEqual(events, ['before', 'after'])
  assert.equal(surface.layoutStyle.display, 'none')
  assert.equal(surface.classes.has('closing'), true)
  assert.equal(surface.appendedNodes.length, 1)

  const [ghost] = surface.appendedNodes
  assert.equal(ghost?.ariaHidden, 'true')
  assert.equal(ghost?.inert, '')
  assert.deepEqual(ghost?.classList.classes, ['example-closing-ghost'])
  assert.equal(ghost?.style.position, 'fixed')
  assert.equal(ghost?.style.left, '12px')
  assert.equal(ghost?.style.top, '24px')
  assert.equal(ghost?.style.width, '240px')
  assert.equal(ghost?.style.height, '36px')
  assert.equal(ghost?.style.opacity, '0')
  assert.equal(ghost?.style.transform, 'scale(0.96)')
  assert.match(ghost?.style.transition ?? '', new RegExp(`opacity ${LAYOUT_REMOVAL_ANIMATION_MS}ms`))
  assert.match(ghost?.style.transition ?? '', new RegExp(`transform ${LAYOUT_REMOVAL_ANIMATION_MS}ms`))
  assert.equal(cleanupDelay, LAYOUT_REMOVAL_ANIMATION_MS + 80)
  assert.equal(ghost?.removed, true)
  assert.equal(surface.visualStyle.maxHeight, undefined)
  assert.equal(surface.visualStyle.paddingTop, undefined)
  assert.equal(surface.layoutAttributes.get('inert'), '')
  assert.equal(surface.visualAttributes.get('inert'), '')
})

test('deferred layout removal reserves the real row until the next render', () => {
  const surface = fakeRemovalSurface()
  const deferredLayout: { release?: () => void } = {}
  let deferredReleaseDelay = 0
  let deferredReleaseCount = 0

  const started = startLayoutRemovalAnimation(surface.visualElement, {
    ghostClassName: 'example-closing-ghost',
    layoutElement: surface.layoutElement,
    deferLayoutRemoval: true,
    onDeferredLayoutRelease: () => {
      deferredReleaseCount += 1
    },
    scheduleCleanup: () => 1,
    scheduleDeferredRelease: (handler, delay) => {
      deferredLayout.release = handler
      deferredReleaseDelay = delay
      return 2
    }
  })

  assert.equal(started, true)
  assert.equal(surface.layoutStyle.display, undefined)
  assert.equal(surface.classes.has('closing'), true)
  assert.equal(surface.appendedNodes.length, 1)
  assert.equal(deferredReleaseDelay, 1_000)

  const releaseDeferredLayout = deferredLayout.release
  assert.ok(releaseDeferredLayout)
  releaseDeferredLayout()
  assert.equal(surface.layoutStyle.display, 'none')
  assert.equal(deferredReleaseCount, 1)
})

test('reduced motion keeps a short opacity exit without scale motion', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: true })
  }
  const surface = fakeRemovalSurface()
  let cleanupDelay = 0

  try {
    startLayoutRemovalAnimation(surface.visualElement, {
      ghostClassName: 'example-closing-ghost',
      layoutElement: surface.layoutElement,
      scheduleCleanup: (_handler, delay) => {
        cleanupDelay = delay
        return 1
      }
    })

    const [ghost] = surface.appendedNodes
    assert.equal(ghost?.style.transform, 'scale(1)')
    assert.match(ghost?.style.transition ?? '', new RegExp(`opacity ${REDUCED_LAYOUT_REMOVAL_ANIMATION_MS}ms`))
    assert.doesNotMatch(ghost?.style.transition ?? '', /transform/)
    assert.equal(cleanupDelay, REDUCED_LAYOUT_REMOVAL_ANIMATION_MS + 80)
  } finally {
    if (previousWindow !== undefined) (globalThis as { window?: unknown }).window = previousWindow
    else delete (globalThis as { window?: unknown }).window
  }
})
