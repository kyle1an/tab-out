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

Creating the window minimized removed that initial target frame, but Chrome
forbids combining minimized state with explicit bounds. The required follow-up
placement update introduced a cross-display race: with a visible source window,
live WindowServer sampling saw the new Chrome window first at source-display
bounds and only then at target-display bounds. That remote frame violates Remote
Display Preservation and cannot be covered by a target-only snapshot.

The safe composition is therefore the original one-step target placement plus
the target-display snapshot. The initial window is never assigned remote
geometry, while the snapshot hides its inactive target-display order until exact
activation and destination focus complete.

The creation path must retain Remote Display Preservation: ordinary Chrome
activation, remote-window restoration, and a focused extension-created window
remain unavailable as fixes.

## Decision

- The extension creates the requested normal Chrome window with `focused: false`
  and the final target-display bounds in the same `chrome.windows.create` call.
  It does not use minimized state or a follow-up bounds update.
- The bridge accepts the request only after Chrome returns the created window's
  identity. Invalid target bounds or a failed create reject the request.
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
  stays above normal windows during the inactive-to-front transition.
- The private helper applies the exact WindowServer foreground and key-window
  sequence and raises that same Accessibility window. Existing visible window
  reuse follows the same private activation path.
- The Spoon removes the snapshot only after the exact Chrome window is
  keyboard-active and its destination control is focused. Completion and every
  failure path both dispose of the canvas. If capture permission or snapshot
  creation is unavailable, creation continues without the optional shield so
  the shortcut's existing availability is preserved.
- No ordinary application activation, `window:focus()`, synthetic click, or
  remote z-order repair is added.

## Consequences

New bridge windows are born at final target bounds. macOS may still present the
window in inactive order before exact activation, but the target-display
snapshot covers that transition. The snapshot is removed only after the Chrome
window is frontmost, so its first exposed frame has final ordering. The
non-target displays receive neither the new window nor a canvas and retain their
window order.

The unpacked extension bundle must be rebuilt, and Chrome must reload the
extension before the new handoff is active. The five-millisecond poll runs only
during the bounded creation request. Every create and reuse route still requires
fresh live Remote Display Preservation qualification on the acceptance Mac.
Seamless transition shielding requires Hammerspoon Screen Recording permission;
without it, routing and focus still work but macOS may expose the normal
inactive-to-front transition.
