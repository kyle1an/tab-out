import { cloneElement, useId, useLayoutEffect, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, PointerEventHandler, ReactElement } from 'react'
import type { PageChipContextMenuContentProps } from './PageChipContextMenuContent'

type LoadedContextMenu = typeof import('./PageChipContextMenuLoaded')['PageChipContextMenuLoaded']

let loadedContextMenu: LoadedContextMenu | null = null
let loadedContextMenuPromise: Promise<LoadedContextMenu> | null = null
const pendingFocusPaths = new WeakMap<Element, number[]>()
const loadingContextMenuInstances = new Set<string>()

function loadPageChipContextMenu(): Promise<LoadedContextMenu> {
  if (loadedContextMenu) return Promise.resolve(loadedContextMenu)
  loadedContextMenuPromise ??= import('./PageChipContextMenuLoaded').then((module) => {
    loadedContextMenu = module.PageChipContextMenuLoaded
    return loadedContextMenu
  }).catch((error: unknown) => {
    loadedContextMenuPromise = null
    throw error
  })
  return loadedContextMenuPromise
}

function focusPath(root: Element, target: EventTarget | null): number[] | null {
  if (!(target instanceof Element) || !root.contains(target)) return null
  const path: number[] = []
  let current: Element | null = target
  while (current && current !== root) {
    const parent: Element | null = current.parentElement
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.children, current) as number
    if (index < 0) return null
    path.unshift(index)
    current = parent
  }
  return current === root ? path : null
}

function elementAtFocusPath(root: HTMLElement, path: readonly number[]): HTMLElement | null {
  let current: Element = root
  for (const index of path) {
    const child = current.children.item(index)
    if (!child) return null
    current = child
  }
  return current instanceof HTMLElement ? current : null
}

export type PageChipContextMenuTriggerElement = ReactElement<{
  className?: string
  'data-context-menu-open'?: string
  'data-tabout-context-menu-instance'?: string
  onFocus?: FocusEventHandler
  onMouseDown?: MouseEventHandler
  onPointerEnter?: PointerEventHandler
}>

type PageChipContextMenuProps = PageChipContextMenuContentProps & {
  children: PageChipContextMenuTriggerElement
  onOpenChange?: (open: boolean) => void
}

export function PageChipContextMenu({
  children,
  onOpenChange,
  ...contentProps
}: PageChipContextMenuProps) {
  const [loadedState, setLoadedState] = useState<{
    Component: LoadedContextMenu
    restoreFocusPath: number[] | null
  } | null>(() => loadedContextMenu
    ? { Component: loadedContextMenu, restoreFocusPath: null }
    : null)
  const LoadedMenu = loadedState?.Component ?? null
  const instanceId = useId()

  function armContextMenu() {
    if (LoadedMenu || loadingContextMenuInstances.has(instanceId)) return
    loadingContextMenuInstances.add(instanceId)
    void loadPageChipContextMenu().then((Component) => {
      loadingContextMenuInstances.delete(instanceId)
      const trigger = document.querySelector<HTMLElement>(`[data-tabout-context-menu-instance="${instanceId}"]`)
      const pendingFocusPath = trigger ? pendingFocusPaths.get(trigger) ?? null : null
      setLoadedState({
        Component,
        restoreFocusPath: pendingFocusPath && trigger?.contains(document.activeElement)
          ? pendingFocusPath
          : null
      })
    }).catch(() => {
      loadingContextMenuInstances.delete(instanceId)
    })
  }

  useLayoutEffect(() => {
    const path = loadedState?.restoreFocusPath
    if (!LoadedMenu || !path) return
    const trigger = document.querySelector<HTMLElement>(`[data-tabout-context-menu-instance="${instanceId}"]`)
    if (!trigger) return
    elementAtFocusPath(trigger, path)?.focus({ preventScroll: true })
  }, [LoadedMenu, instanceId, loadedState?.restoreFocusPath])

  const armedTrigger = cloneElement(children, {
    'data-tabout-context-menu-instance': instanceId,
    onFocus: (event) => {
      children.props.onFocus?.(event)
      const path = focusPath(event.currentTarget, event.target)
      if (path) pendingFocusPaths.set(event.currentTarget, path)
      else pendingFocusPaths.delete(event.currentTarget)
      armContextMenu()
    },
    onMouseDown: (event) => {
      children.props.onMouseDown?.(event)
      if (event.button === 2) armContextMenu()
    },
    onPointerEnter: (event) => {
      children.props.onPointerEnter?.(event)
      armContextMenu()
    }
  })

  if (!LoadedMenu) return armedTrigger

  return (
    <LoadedMenu
      onOpenChange={onOpenChange}
      {...contentProps}
    >
      {armedTrigger}
    </LoadedMenu>
  )
}
