import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { registerToastDispatch } from '../../extension/toast.js'

const DURATION_WITHOUT_ACTION = 2500
const DURATION_WITH_ACTION = 6000

function durationFor(action) {
  return action ? DURATION_WITH_ACTION : DURATION_WITHOUT_ACTION
}

export function Toast() {
  const [state, setState] = useState({ visible: false, message: '', action: null, nonce: 0 })
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return registerToastDispatch((incoming) => {
      setState((prev) => ({
        visible: true,
        message: incoming.message,
        action: incoming.action,
        nonce: prev.nonce + 1
      }))
    })
  }, [])

  useEffect(() => {
    if (!state.visible) return
    const timer = window.setTimeout(() => setState((s) => ({ ...s, visible: false })), durationFor(state.action))
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
    timerRef.current = window.setTimeout(() => setState((s) => ({ ...s, visible: false })), durationFor(state.action))
  }

  const onActionClick = () => {
    if (state.action?.onClick) state.action.onClick()
    setState((s) => ({ ...s, visible: false }))
  }

  const className = 'toast' + (state.visible ? ' visible' : '')

  return (
    <div className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      <span>{state.message}</span>
      {state.action && (
        <button className="toast-action" onClick={onActionClick}>
          {state.action.label}
        </button>
      )}
    </div>
  )
}

export function mountToast() {
  const el = document.getElementById('toastRoot')
  if (!el) return
  createRoot(el).render(<Toast />)
}
