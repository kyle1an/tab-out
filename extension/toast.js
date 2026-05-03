let activeDispatch = null
let pendingToast = null

export function showToast(message, action = null) {
  const incoming = { message, action }
  if (activeDispatch) {
    activeDispatch(incoming)
  } else {
    pendingToast = incoming
  }
}

export function registerToastDispatch(dispatch) {
  activeDispatch = dispatch
  if (pendingToast) {
    activeDispatch(pendingToast)
    pendingToast = null
  }

  return () => {
    if (activeDispatch === dispatch) activeDispatch = null
  }
}
