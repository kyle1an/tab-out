/* ================================================================
   <Toast> — bottom-screen notification pill.

   Replaces the old imperative showToast in ui.js, which mutated
   #toast's children, classList, and attached event listeners by
   hand. Now a single Preact component owns the toast DOM; the
   imperative API (showToast(message, action?)) is preserved — it
   just sets the component's state.

   mountToast() has to be called once before showToast is first
   invoked; app.js does this during startup. Any showToast calls
   that happen before mount are captured in `pendingToast` and
   flushed when the component registers.

   The toast pauses its auto-hide while the cursor is over it, so
   undo actions always have time to be clicked — implemented with
   a timer ref that mouseenter clears and mouseleave restarts.
   ================================================================ */

import { h, render as preactRender } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useRef, useState } from '../vendor/preact-hooks.mjs'

const html = htm.bind(h)

// Set by the Toast component on mount so showToast can dispatch
// into it. Any calls before mount land in pendingToast instead
// and flush when the component registers.
let activeDispatch = null
let pendingToast = null

const DURATION_WITHOUT_ACTION = 2500
const DURATION_WITH_ACTION = 6000

function durationFor(action) {
  return action ? DURATION_WITH_ACTION : DURATION_WITHOUT_ACTION
}

export function showToast(message, action = null) {
  const incoming = { message, action }
  if (activeDispatch) {
    activeDispatch(incoming)
  } else {
    pendingToast = incoming
  }
}

export function Toast() {
  const [state, setState] = useState({ visible: false, message: '', action: null, nonce: 0 })
  const timerRef = useRef(null)

  // Register the module-level dispatcher on mount. A nonce on every
  // incoming toast lets the auto-hide effect restart even when the
  // message string repeats (e.g. closing two tabs in a row).
  useEffect(() => {
    activeDispatch = (incoming) => {
      setState((prev) => ({
        visible: true,
        message: incoming.message,
        action: incoming.action,
        nonce: prev.nonce + 1
      }))
    }
    if (pendingToast) {
      activeDispatch(pendingToast)
      pendingToast = null
    }
    return () => {
      activeDispatch = null
    }
  }, [])

  // Auto-hide timer. Re-armed on every new toast (nonce change).
  // Cleanup on nonce change or unmount cancels the pending hide.
  useEffect(() => {
    if (!state.visible) return
    const timer = setTimeout(() => setState((s) => ({ ...s, visible: false })), durationFor(state.action))
    timerRef.current = timer
    return () => clearTimeout(timer)
  }, [state.nonce])

  const onMouseEnter = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const onMouseLeave = () => {
    if (!state.visible || timerRef.current !== null) return
    timerRef.current = setTimeout(() => setState((s) => ({ ...s, visible: false })), durationFor(state.action))
  }

  const onActionClick = () => {
    if (state.action?.onClick) state.action.onClick()
    setState((s) => ({ ...s, visible: false }))
  }

  const className = 'toast' + (state.visible ? ' visible' : '')

  return html`
    <div class=${className} onMouseEnter=${onMouseEnter} onMouseLeave=${onMouseLeave}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      <span>${state.message}</span>
      ${state.action && html` <button class="toast-action" onClick=${onActionClick}>${state.action.label}</button> `}
    </div>
  `
}

export function mountToast() {
  const el = document.getElementById('toastRoot')
  if (!el) return
  preactRender(html`<${Toast} />`, el)
}
