# ADR 0010: Reveal macOS Windows During Exact Activation

- Status: Accepted
- Date: 2026-08-01

## Context

ADR 0008 created a normal Chrome window at its final bounds with
`focused: false`, then asked Hammerspoon to privately activate the validated
native window. WindowServer presents that normal inactive window behind the
current application before Hammerspoon can observe and focus it. Moving the
focus call earlier reduced some waiting but could not prevent the first inactive
frame because the window was already visible.

Creating the window minimized removed that initial frame, but live WindowServer
sampling showed a second macOS behavior: the unminimize animation exposes the
window in its inactive order for roughly 150–480 milliseconds before the exact
focus handoff takes effect. Reordering the private calls did not change that
animation, and WindowServer denied direct ordering of Chrome's managed window.

The creation path must retain Remote Display Preservation: ordinary Chrome
activation, remote-window restoration, and a focused extension-created window
remain unavailable as fixes.

## Decision

- The extension creates the requested normal Chrome window with
  `focused: false` and `state: minimized`. Chrome does not allow minimized state
  and explicit bounds in the same create call, so the extension applies the
  target bounds with a second `chrome.windows.update` while the window remains
  concealed.
- The bridge accepts the request only after concealed placement completes. If
  placement fails, the extension best-effort removes the concealed window and
  rejects the request.
- While a bridge request is pending, the Spoon keeps a short-lived poll for a
  new baseline-excluded Chrome window. It acts only after bridge acceptance,
  retains the existing window-created event as a fallback signal, and stops the
  poll on success, failure, or timeout.
- The Spoon validates the new window's display, Space, configured profile,
  Chrome PID, and native window ID before invoking Private Exact-Window
  Activation.
- When Screen Recording permission is available, the Spoon snapshots the target
  display immediately before requesting creation and presents that image in a
  non-focusable floating canvas. The canvas covers only the target display and
  stays above normal windows during the native unminimize animation.
- The private helper applies the exact WindowServer foreground and key-window
  sequence while the validated window is still minimized, then clears
  `AXMinimized` and raises that same Accessibility window. Existing visible
  window reuse follows the same private activation path without a reveal step.
- The Spoon removes the snapshot only after the exact Chrome window is
  keyboard-active and its destination control is focused. Completion and every
  failure path both dispose of the canvas. If capture permission or snapshot
  creation is unavailable, creation continues without the optional shield so
  the shortcut's existing availability is preserved.
- No ordinary application activation, `window:focus()`, synthetic click, or
  remote z-order repair is added.

## Consequences

New bridge windows remain absent until private activation begins. macOS still
animates the unminimized window through its inactive order, but the unchanged
target-display snapshot covers that transition. The snapshot is removed only
after the Chrome window is frontmost, so its first exposed frame has final
ordering. The non-target displays receive no canvas and retain their window
order.

The unpacked extension bundle and private Hammerspoon helper must both be
rebuilt, and Chrome must reload the extension before the new handoff is active.
The five-millisecond poll runs only during the bounded creation request. Every
create and reuse route still requires fresh live Remote Display Preservation
qualification on the acceptance Mac. Seamless transition shielding requires
Hammerspoon Screen Recording permission; without it, routing and focus still
work but macOS may expose the normal unminimize animation.
