# ADR 0011: Restore Prior Order When Closing Created macOS Windows

- Status: Accepted
- Date: 2026-08-02

## Context

After the Native Placement Bridge creates and activates a Chrome window on an
otherwise Chrome-empty target display, closing that active window can make
Chrome promote one of its remaining windows on another display. This changes
the remote display from its existing non-Chrome front window to Chrome even
though the shortcut's creation path preserved that order.

The same fallback can promote an older Chrome window on the target display when
the bridge created an additional window above the invocation-time non-Chrome
window. The promotion is Chrome's active-window close fallback, not a side
effect of Private Exact-Window Activation. Chrome's focus transition can occur
before Hammerspoon receives the window destruction notification, and live
Chrome qualification found that the notification may not arrive at all for a
directly placed window. A destruction callback alone therefore cannot reliably
restore final state or prevent the intervening Chrome frame.

## Decision

- For each Native Placement Bridge window, the Spoon may retain the exact
  invocation-time focused window as close recovery state. It does so only when
  that window belongs to a non-Chrome application and is still the frontmost
  normal window on its display's active Space. On the target display, the exact
  created window is excluded from that check, so the prior window must remain
  directly beneath it.
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
- A 100-millisecond existence monitor runs only while an eligible
  bridge-created window has recovery state. Window destruction stops the
  monitor and clears that state when Chrome reports it normally. If Chrome
  omits the destruction event, the monitor detects that the exact native window
  is gone. For either signal, bounded recovery restores the remembered window
  only when Chrome's fallback owns focus; this repairs final state but does not
  claim a flash-free transition for unhandled close paths.
- This decision narrows ADR 0010's prohibition on ordinary `window:focus()` and
  remote repair only for the later close lifecycle of a successfully created
  window. Creation, routing, and exact activation retain ADR 0010's stricter
  rule and never use those operations as a fallback.

## Consequences

The red close button, Command-Shift-W, and last-tab Command-W close the created
window only after the prior non-Chrome window is active, so Chrome has no reason
to promote another Chrome window on either display. Normal Command-W tab
closing remains native when more than one tab exists.

The interception is intentionally narrow and requires a still-valid remembered
window. Menu commands, automation, accessibility actions, or another close path
that cannot be observed before Chrome acts may still show a transient remote
Chrome frame, although eligible recovery restores the final focus after window
closure even when Chrome omits its Accessibility destruction event. The monitor
exists only for recovery-eligible bridge-created windows and stops with that
window. Live qualification therefore covers each intercepted gesture in
addition to the creation and reuse routes required by ADR 0010.
