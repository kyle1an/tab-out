# ADR 0012: Create A Profile-Owned Window On Occupied macOS Spaces

- Status: Accepted
- Date: 2026-08-02

## Context

The Spoon originally identified an existing Chrome window's profile from
Chrome's Profiles menu and cached that identity only after the window received
focus. If a non-Chrome window was frontmost when the shortcut ran, an existing
target-Space Chrome window could therefore remain unverified even when it
belonged to the configured profile.

The router correctly refused to focus that unverified window, but its creation
fallback also required the target Space to be Chrome-empty. The combination
made both shortcuts Safe Abort solely because an untouched Chrome window was
behind the user's active non-Chrome window. Native Placement Bridge creation
does not require that restriction: Hammerspoon snapshots the existing native
window IDs before the request and observes the newly created window separately.

## Decision

- Existing-window reuse continues to require a verified configured-profile
  identity.
- Before falling back to creation, the profile-scoped extension reports its
  normal, non-minimized browser window IDs through the Native Placement Bridge.
  Chrome AppleScript maps those browser IDs to bounds and the active document,
  while Accessibility supplies the same local values for native windows. The
  Spoon caches a configured-profile identity only when that fingerprint is
  unique across Chrome's current windows; neither query activates Chrome.
- Unverified and known other-profile Chrome windows remain untouched and are
  never used as focus or navigation targets.
- When no verified configured-profile target window remains, the Native
  Placement Bridge may create a configured-profile window on the target Space
  even when other normal Chrome windows already occupy that Space.
- The created window retains the existing final-bounds placement, transition
  shield, native-window validation, Private Exact-Window Activation, and
  destination-control focus sequence.

## Consequences

Both shortcuts remain available when a non-Chrome app is frontmost over an
unverified or other-profile Chrome window. An unambiguous configured-profile
window is now reused without first focusing it. Missing documents, changing
window state, duplicate fingerprints, an unavailable bridge, or Automation and
Accessibility failures retain the safe creation fallback rather than risk
focusing the wrong profile.

If ambiguity still requires an additional window, ADR 0011's close recovery can
restore the invocation-time non-Chrome window on the target display.

Occupied-target creation joins Chrome-empty creation and verified-window reuse
in the live Remote Display Preservation qualification matrix.
