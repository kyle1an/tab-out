# ADR 0011: Preserve Remote Order When Closing Created macOS Windows

- Status: Accepted
- Date: 2026-08-02

## Context

After the Native Placement Bridge creates and activates a Chrome window on an
otherwise Chrome-empty target display, closing that active window can make
Chrome promote one of its remaining windows on another display. This changes
the remote display from its existing non-Chrome front window to Chrome even
though the shortcut's creation path preserved that order.

The promotion is Chrome's active-window close fallback, not a side effect of
Private Exact-Window Activation. Closing the same target window while a
non-Chrome window is already focused preserves the remote order, while closing
it after either private or ordinary public focus promotes remote Chrome.
Chrome's focus transition also occurs before Hammerspoon receives the window
destruction notification. A destruction callback can restore the final state,
but it cannot prevent the intervening Chrome frame.

## Decision

- For each Native Placement Bridge window, the Spoon may retain the exact
  invocation-time focused window as close recovery state. It does so only when
  that window belongs to a non-Chrome application on another display and is
  still the frontmost normal window on that display's active Space.
- The Spoon intercepts common whole-window close gestures only for the exact
  focused bridge-created window with still-eligible recovery state: the red
  close button, Command-Shift-W, and Command-W when an Accessibility scan proves
  that the window contains exactly one tab.
- Before closing, the Spoon consumes the gesture, focuses the remembered
  non-Chrome window, verifies that exact focus, and closes the created window
  through Accessibility. If recovery is already ineligible, the gesture passes
  through to Chrome. If recovery becomes unavailable after interception, the
  Spoon still closes the target so the user's close intent is not lost.
- Multi-tab Command-W and gestures targeting any other window remain
  Chrome-owned. The paired mouse-up from an intercepted red-button press is
  suppressed so it cannot land in the newly focused application.
- Window destruction clears the recovery record. For an unhandled close path,
  the destruction callback restores the remembered window when Chrome's
  fallback has landed on another display; this repairs final state but does not
  claim a flash-free transition.
- This decision narrows ADR 0010's prohibition on ordinary `window:focus()` and
  remote repair only for the later close lifecycle of a successfully created
  window. Creation, routing, and exact activation retain ADR 0010's stricter
  rule and never use those operations as a fallback.

## Consequences

The red close button, Command-Shift-W, and last-tab Command-W close the created
window only after the prior non-Chrome window is active, so Chrome has no reason
to promote a remote Chrome window. Normal Command-W tab closing remains native
when more than one tab exists.

The interception is intentionally narrow and requires a still-valid remembered
window. Menu commands, automation, accessibility actions, or another close path
that cannot be observed before Chrome acts may still show a transient remote
Chrome frame, although eligible recovery restores the final focus after window
destruction. Live qualification therefore covers each intercepted gesture in
addition to the creation and reuse routes required by ADR 0010.
